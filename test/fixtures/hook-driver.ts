import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../../src/index";

const root = mkdtempSync(join(tmpdir(), "command-approval-hook-driver-"));
const xdg = join(root, "xdg");
const capturePath = join(root, "tirith-commands.txt");
const tirithPath = join(root, "fake-tirith");
const previousXdg = process.env["XDG_CONFIG_HOME"];
let reviewerCount = 0;
let reviewerObservedScan = false;

const reviewer = Bun.serve({
  port: 0,
  fetch() {
    reviewerCount += 1;
    reviewerObservedScan = existsSync(capturePath) && readFileSync(capturePath, "utf8").trim().length > 0;
    return Response.json({
      id: "chatcmpl-hook-test",
      object: "chat.completion",
      created: 0,
      model: "hook-test",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: JSON.stringify({
            outcome: "allow",
            risk_level: "low",
            user_authorization: "high",
            categories: [{ id: "test.hook", score: 0 }],
            reasons: ["fake reviewer approval"],
          }),
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  },
});

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
    version: 2,
    review: {
      base_url: `${reviewer.url.origin}/v1`,
      api_key: "test-key",
      model: "hook-test",
      max_retries: 0,
      context_messages: 0,
    },
    tirith: { enabled: true, path: tirithPath, timeout_ms: 5_000, fail_open: false },
    rules: {
      allow: [{ match: "^trusted-(?:left|right)(?:\\s|$).*", scope: "segment", priority: 100 }],
      deny: [{ match: "^denied(?:\\s|$).*", scope: "segment", priority: 100 }],
    },
  }));

  const hooks = await plugin.server({ directory: root });
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
    { args: { command: "cd subdir && printf '{}' > ../command-approval.jsonc" } },
  ));
  const dashDirectoryProtectionError = await errorMessage(hook(
    { tool: "bash", sessionID: "dash-directory", callID: "dash-directory-call" },
    { args: { command: "cd -- -foo && printf '{}' > ../command-approval.jsonc" } },
  ));
  const directoryDestinationProtectionError = await errorMessage(hook(
    { tool: "bash", sessionID: "directory-destination", callID: "directory-destination-call" },
    { args: { command: `cp '${copySource}' .` } },
  ));
  const cpTrailingOptionProtectionError = await errorMessage(hook(
    { tool: "bash", sessionID: "cp-trailing-option", callID: "cp-trailing-option-call" },
    { args: { command: `cp '${ordinarySource}' command-approval.jsonc -S .bak` } },
  ));
  const installTrailingOptionProtectionError = await errorMessage(hook(
    { tool: "bash", sessionID: "install-trailing-option", callID: "install-trailing-option-call" },
    { args: { command: `install '${ordinarySource}' command-approval.jsonc -m 600` } },
  ));
  const rsyncShortOptionProtectionError = await errorMessage(hook(
    { tool: "bash", sessionID: "rsync-short-option", callID: "rsync-short-option-call" },
    { args: { command: `rsync -t '${ordinarySource}' command-approval.jsonc` } },
  ));
  const rsyncTrailingOptionProtectionError = await errorMessage(hook(
    { tool: "bash", sessionID: "rsync-trailing-option", callID: "rsync-trailing-option-call" },
    { args: { command: `rsync '${ordinarySource}' command-approval.jsonc --exclude ignored` } },
  ));
  const rsyncUnknownOptionProtectionError = await errorMessage(hook(
    { tool: "bash", sessionID: "rsync-unknown-option", callID: "rsync-unknown-option-call" },
    { args: { command: `rsync '${ordinarySource}' command-approval.jsonc --stop-after 5` } },
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
  reviewer.stop(true);
  if (previousXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = previousXdg;
  rmSync(root, { recursive: true, force: true });
}
