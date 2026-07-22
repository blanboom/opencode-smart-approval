import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMonotonicDeadline } from "../../src/bounded-race";
import { createApprovalPluginIntegration, createHook } from "../../src/index";
import { reviewWithOpenCode } from "../../src/opencode-reviewer";
import type { SerializeReviewRequestInput } from "../../src/review-request";
import { FakeAnchoredFsAdapter } from "./fake-anchored-fs";
import { expectedAgentFixture, validCreatedSession, validPromptResponse } from "./opencode-review-fixtures";
import { fakeClient } from "./opencode-client-fake";

const variant = process.argv[2];
const root = mkdtempSync(join(tmpdir(), "approval-canonical-plugin-"));
const xdgConfig = join(root, "config");
const xdgData = join(root, "data");
const workspace = join(root, "workspace");
const previousConfig = process.env["XDG_CONFIG_HOME"];
const previousData = process.env["XDG_DATA_HOME"];

const stringField = (value: unknown, key: string): string | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const field = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
};

const nestedStringField = (value: unknown, container: string, key: string): string | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return stringField(Reflect.get(value, container), key);
};

const rawDirectory = (): string => {
  switch (variant) {
    case "dot":
      return `${workspace}/.`;
    case "parent":
      return `${workspace}/nested/..`;
    case "separators":
      return workspace.replace("/workspace", "///workspace//.");
    default:
      throw new TypeError("expected dot, parent, or separators variant");
  }
};

const promptCwd = (options: unknown): string | undefined => {
  if (typeof options !== "object" || options === null || Array.isArray(options)) return undefined;
  const body = Reflect.get(options, "body");
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const parts = Reflect.get(body, "parts");
  if (!Array.isArray(parts) || parts.length === 0) return undefined;
  const text = stringField(parts[0], "text");
  if (!text) return undefined;
  return stringField(JSON.parse(text), "cwd");
};

const responseFor = (childID: string) => {
  const response = validPromptResponse();
  const messageID = `assistant-${childID}`;
  return {
    ...response,
    info: {
      ...response.info,
      id: messageID,
      sessionID: childID,
      modelID: "reviewer-model",
      providerID: "reviewer-provider",
      path: { cwd: workspace, root: workspace },
    },
    parts: response.parts.map((part) => ({ ...part, sessionID: childID, messageID })),
  };
};

try {
  mkdirSync(join(xdgConfig, "opencode"), { recursive: true });
  mkdirSync(join(workspace, "nested"), { recursive: true });
  writeFileSync(join(xdgConfig, "opencode", "command-approval.jsonc"), JSON.stringify({
    version: 3,
    self_protection: { enabled: true },
    review: { timeout_ms: 5_000, context_messages: 4 },
    tirith: { enabled: false },
    rules: { allow: [], deny: [], review: [] },
  }));
  process.env["XDG_CONFIG_HOME"] = xdgConfig;
  process.env["XDG_DATA_HOME"] = xdgData;

  const expectedAgent = expectedAgentFixture(
    "reviewer-provider/reviewer-model",
    join(xdgData, "opencode", "tool-output", "*"),
  );
  let children = 0;
  let settleLateCreate: ((value: unknown) => void) | undefined;
  let observeLateLog: (() => void) | undefined;
  const lateCreate = new Promise<unknown>((resolve) => { settleLateCreate = resolve; });
  const lateLogged = new Promise<void>((resolve) => { observeLateLog = resolve; });
  const fake = fakeClient(async (method, options) => {
    if (method === "messages") return { data: [] };
    if (method === "agents") return { data: [expectedAgent.runtime] };
    if (method === "create") {
      const parentID = nestedStringField(options, "body", "parentID") ?? "parent-session";
      if (parentID === "late-parent") return lateCreate;
      children += 1;
      return {
        data: {
          ...validCreatedSession(),
          id: `canonical-child-${String(children)}`,
          projectID: "canonical-project",
          directory: workspace,
          parentID,
        },
      };
    }
    if (method === "prompt") {
      return { data: responseFor(nestedStringField(options, "path", "id") ?? "canonical-child") };
    }
    if (method === "log") { observeLateLog?.(); return { data: true }; }
    if (method === "delete" || method === "abort") return { data: true };
    return { error: { name: "unexpected_call", data: {} } };
  });
  const adapter = new FakeAnchoredFsAdapter();
  adapter.addDirectory(workspace);
  adapter.addDirectory("/tmp");
  let factoryDirectory: string | undefined;
  let runtimeDirectory: string | undefined;
  const integration = createApprovalPluginIntegration(
    {
      directory: rawDirectory(),
      worktree: rawDirectory(),
      project: { id: "canonical-project" },
      client: fake.client,
    },
    {
      adapter,
      environment: { XDG_DATA_HOME: xdgData },
      homeDirectory: "/unused-home",
      tempDirectory: "/tmp",
      createToolExecuteBefore: ({ directory, reviewerRuntime }) => {
        factoryDirectory = directory;
        runtimeDirectory = reviewerRuntime()?.directory;
        return createHook(directory, { reviewerRuntime });
      },
    },
  );
  const hooks = integration.hooks;
  await hooks.config?.({ small_model: "reviewer-provider/reviewer-model" });
  const toolExecuteBefore = hooks["tool.execute.before"];
  if (!toolExecuteBefore) throw new Error("tool.execute.before hook is missing");
  await toolExecuteBefore(
    { tool: "bash", sessionID: "canonical-parent", callID: "canonical-call" },
    { args: { command: "scanner-allow" } },
  );
  const normalCalls = [...fake.calls];
  const prompt = fake.calls.find((call) => call.method === "prompt");
  const runtime = integration.reviewerRuntime();
  if (!runtime) throw new Error("reviewer runtime is missing");
  const request: SerializeReviewRequestInput = {
    context: { sessionID: "late-parent", tool: "bash", command: "scanner-allow", cwd: workspace, args: {} },
    shellAnalysis: {
      source: "scanner-allow", segments: [], redirections: [], staticFileReferences: [], issues: [], nestedAnalyses: [],
    },
    evaluation: { decision: "review", matchedRules: [], categories: [], reasons: [] },
    tirith: { action: "allow" },
    transcript: { status: "disabled" },
  };
  const lateResponse = await reviewWithOpenCode(runtime, {
    parentSessionID: "late-parent",
    deadline: createMonotonicDeadline(3),
    request,
  });
  settleLateCreate?.({
    data: {
      ...validCreatedSession(),
      id: "late-child",
      projectID: "canonical-project",
      directory: workspace,
      parentID: "late-parent",
    },
  });
  await lateLogged;
  const lateCalls = fake.calls.slice(normalCalls.length);
  console.log(JSON.stringify({
    canonical: workspace,
    directories: normalCalls.map((call) => nestedStringField(call.options, "query", "directory")),
    factoryDirectory,
    lateDirectories: lateCalls.map((call) => nestedStringField(call.options, "query", "directory")),
    lateMethods: lateCalls.map((call) => call.method),
    lateOutcome: lateResponse.outcome,
    methods: normalCalls.map((call) => call.method),
    promptCwd: prompt ? promptCwd(prompt.options) : undefined,
    runtimeDirectory,
  }));
  await hooks.dispose?.();
} finally {
  if (previousConfig === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = previousConfig;
  if (previousData === undefined) delete process.env["XDG_DATA_HOME"];
  else process.env["XDG_DATA_HOME"] = previousData;
  rmSync(root, { recursive: true, force: true });
}
