import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApprovalPluginIntegration, createHook } from "../../src/index";
import { FakeAnchoredFsAdapter } from "./fake-anchored-fs";
import { expectedAgentFixture, validCreatedSession, validPromptResponse } from "./opencode-review-fixtures";
import { fakeClient } from "./opencode-client-fake";

const root = mkdtempSync(join(tmpdir(), "command-approval-hook-driver-"));
const xdg = join(root, "xdg");
const capturePath = join(root, "tirith-commands.txt");
const tirithPath = join(root, "fake-tirith");
const previousXdg = process.env["XDG_CONFIG_HOME"];
const previousXdgData = process.env["XDG_DATA_HOME"];
let reviewerCount = 0;
let reviewerObservedScan = false;

const errorMessage = async (operation: Promise<void>): Promise<string> => {
  try {
    await operation;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

try {
  process.env["XDG_CONFIG_HOME"] = xdg;
  const xdgData = join(root, "data");
  process.env["XDG_DATA_HOME"] = xdgData;
  mkdirSync(join(xdg, "opencode"), { recursive: true });
  mkdirSync(join(root, "subdir"));
  mkdirSync(join(root, "-foo"));
  const copySource = join(root, "source", "command-approval.jsonc");
  const ordinarySource = join(root, "source", "payload");
  mkdirSync(join(root, "source"));
  writeFileSync(copySource, "{}");
  writeFileSync(ordinarySource, "payload");
  writeFileSync(
    tirithPath,
    `#!/bin/sh
printf '%s\\n' "$7" >> "${capturePath}"
printf '%s\\n' '{"summary":"fake scan","findings":[]}'
case $7 in *scanner-block*) exit 1 ;; *) exit 0 ;; esac
`,
  );
  chmodSync(tirithPath, 0o755);
  const policyPath = join(xdg, "opencode", "command-approval.jsonc");
  writeFileSync(policyPath, JSON.stringify({
    version: 3,
    review: {
      context_messages: 0,
    },
    tirith: { enabled: true, path: tirithPath, timeout_ms: 5_000, fail_open: false },
    rules: {
      allow: [{ match: "^trusted-(?:left|right)(?:\\s|$).*", scope: "segment", priority: 100 }],
      deny: [{ match: "^denied(?:\\s|$).*", scope: "segment", priority: 100 }],
    },
  }));

  const expectedAgent = expectedAgentFixture("hook-provider/hook-model", join(xdgData, "opencode", "tool-output", "*"));
  let children = 0;
  const stringField = (value: unknown, key: string): string | undefined => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const field = Reflect.get(value, key);
    return typeof field === "string" ? field : undefined;
  };
  const nestedStringField = (value: unknown, container: string, key: string): string | undefined => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return stringField(Reflect.get(value, container), key);
  };
  const responseFor = (childID: string) => {
    const response = validPromptResponse({
      outcome: "allow",
      risk_level: "low",
      user_authorization: "high",
      categories: [{ id: "test.hook", score: 0 }],
      reasons: ["fake reviewer approval"],
    });
    const messageID = `assistant-${childID}`;
    return {
      ...response,
      info: {
        ...response.info,
        id: messageID,
        sessionID: childID,
        modelID: "hook-model",
        providerID: "hook-provider",
        path: { cwd: root, root },
      },
      parts: response.parts.map((part) => ({ ...part, sessionID: childID, messageID })),
    };
  };
  const fake = fakeClient(async (method, options) => {
    if (method === "agents") return { data: [expectedAgent.runtime] };
    if (method === "messages") return { data: [] };
    if (method === "create") {
      children += 1;
      return {
        data: {
          ...validCreatedSession(),
          id: `hook-child-${String(children)}`,
          projectID: "project-id",
          directory: root,
          parentID: nestedStringField(options, "body", "parentID") ?? "parent",
        },
      };
    }
    if (method === "prompt") {
      reviewerCount += 1;
      reviewerObservedScan = existsSync(capturePath) && readFileSync(capturePath, "utf8").trim().length > 0;
      return { data: responseFor(nestedStringField(options, "path", "id") ?? "hook-child") };
    }
    if (method === "abort" || method === "delete" || method === "log") return { data: true };
    return { error: { name: "unexpected_call", data: {} } };
  });
  const readerAdapter = new FakeAnchoredFsAdapter();
  readerAdapter.addDirectory(root);
  readerAdapter.addDirectory("/tmp");
  const integration = createApprovalPluginIntegration(
    { directory: root, worktree: root, project: { id: "project-id" }, client: fake.client },
    {
      adapter: readerAdapter,
      environment: { XDG_DATA_HOME: xdgData },
      homeDirectory: "/unused-home",
      tempDirectory: "/tmp",
      createToolExecuteBefore: ({ directory, reviewerRuntime }) => createHook(directory, { reviewerRuntime }),
    },
  );
  const hooks = integration.hooks;
  await hooks.config?.({ small_model: "hook-provider/hook-model" });
  const hook = hooks["tool.execute.before"];
  if (!hook) throw new Error("tool.execute.before hook is missing");

  await hook(
    { tool: "bash", sessionID: "allowed", callID: "allowed-call" },
    { args: { command: "trusted-left | trusted-right" } },
  );
  const afterUserAllow = { reviewerCount, scans: existsSync(capturePath) ? readFileSync(capturePath, "utf8") : "" };

  const deniedError = await errorMessage(hook(
    { tool: "bash", sessionID: "denied", callID: "denied-call" },
    { args: { command: "denied" } },
  ));
  await hook(
    { tool: "bash", sessionID: "review", callID: "review-call" },
    { args: { command: "scanner-allow" } },
  );
  const scannerBlockedError = await errorMessage(hook(
    { tool: "bash", sessionID: "scanner-block", callID: "scanner-block-call" },
    { args: { command: "scanner-block" } },
  ));
  const selfProtectionError = await errorMessage(hook(
    { tool: "write", sessionID: "protected", callID: "protected-call" },
    { args: { filePath: policyPath, content: "{}" } },
  ));
  const changedDirectoryProtectionError = await errorMessage(hook(
    { tool: "bash", sessionID: "changed-directory", callID: "changed-directory-call" },
    { args: { command: "cd subdir && printf '{}' > ../xdg/opencode/command-approval.jsonc" } },
  ));
  const dashDirectoryProtectionError = await errorMessage(hook(
    { tool: "bash", sessionID: "dash-directory", callID: "dash-directory-call" },
    { args: { command: "cd -- -foo && printf '{}' > ../xdg/opencode/command-approval.jsonc" } },
  ));
  const directoryDestinationProtectionError = await errorMessage(hook(
    { tool: "bash", sessionID: "directory-destination", callID: "directory-destination-call" },
    { args: { command: `cp '${copySource}' '${join(xdg, "opencode")}'` } },
  ));
  const cpTrailingOptionProtectionError = await errorMessage(hook(
    { tool: "bash", sessionID: "cp-trailing-option", callID: "cp-trailing-option-call" },
    { args: { command: `cp '${ordinarySource}' '${policyPath}' -S .bak` } },
  ));
  const installTrailingOptionProtectionError = await errorMessage(hook(
    { tool: "bash", sessionID: "install-trailing-option", callID: "install-trailing-option-call" },
    { args: { command: `install '${ordinarySource}' '${policyPath}' -m 600` } },
  ));
  const rsyncShortOptionProtectionError = await errorMessage(hook(
    { tool: "bash", sessionID: "rsync-short-option", callID: "rsync-short-option-call" },
    { args: { command: `rsync -t '${ordinarySource}' '${policyPath}'` } },
  ));
  const rsyncTrailingOptionProtectionError = await errorMessage(hook(
    { tool: "bash", sessionID: "rsync-trailing-option", callID: "rsync-trailing-option-call" },
    { args: { command: `rsync '${ordinarySource}' '${policyPath}' --exclude ignored` } },
  ));
  const rsyncUnknownOptionProtectionError = await errorMessage(hook(
    { tool: "bash", sessionID: "rsync-unknown-option", callID: "rsync-unknown-option-call" },
    { args: { command: `rsync '${ordinarySource}' '${policyPath}' --stop-after 5` } },
  ));

  console.log(JSON.stringify({
    afterUserAllow,
    changedDirectoryProtectionError,
    cpTrailingOptionProtectionError,
    dashDirectoryProtectionError,
    deniedError,
    directoryDestinationProtectionError,
    installTrailingOptionProtectionError,
    reviewerCount,
    reviewerObservedScan,
    rsyncShortOptionProtectionError,
    rsyncTrailingOptionProtectionError,
    rsyncUnknownOptionProtectionError,
    scannerBlockedError,
    selfProtectionError,
    tirithCommands: readFileSync(capturePath, "utf8").trim().split("\n"),
  }));
} finally {
  if (previousXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = previousXdg;
  if (previousXdgData === undefined) delete process.env["XDG_DATA_HOME"];
  else process.env["XDG_DATA_HOME"] = previousXdgData;
  rmSync(root, { recursive: true, force: true });
}
