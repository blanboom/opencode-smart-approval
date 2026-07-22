import { describe, expect, test } from "bun:test";
import { buildCommandContext } from "../src/context";
import type { PolicyLoadResult } from "../src/config";
import { defaultPolicy } from "../src/default-config";
import { createHook } from "../src/index";

const loadedPolicy = (policyPath: string): PolicyLoadResult => ({
  ok: true,
  policy: {
    ...defaultPolicy(),
    tirith: { enabled: false, timeoutMs: 5_000, failOpen: false },
    rules: [],
  },
  path: policyPath,
  effectivePolicyPaths: [policyPath],
  initialized: false,
});

describe("OpenCode bash execution workdir", () => {
  test.each([
    ["relative", "./nested/../execution", "/workspace/execution"],
    ["absolute", "/tmp/./execution", "/tmp/execution"],
    ["empty default", "", "/workspace"],
  ] as const)("canonicalizes the %s spelling before building command context", (_label, workdir, expected) => {
    // Given an OpenCode bash argument object with one accepted workdir spelling.
    const args = { command: "pwd", description: "Print execution directory", workdir };

    // When the command context crosses the untrusted tool-argument boundary.
    const context = buildCommandContext({ tool: "bash", sessionID: "parent" }, args, "/workspace/.");

    // Then execution cwd is canonical while the complete original args remain bound.
    expect(context).toEqual({
      sessionID: "parent",
      tool: "bash",
      command: "pwd",
      cwd: expected,
      args,
    });
  });

  test.each([null, 42, {}, "bad\0path"])("rejects invalid workdir input: %p", (workdir) => {
    // Given a command whose workdir cannot be an OpenCode execution directory.
    const args = { command: "test -n value", workdir };

    // When context construction validates the tool arguments.
    const context = buildCommandContext({ tool: "bash", sessionID: "parent" }, args, "/workspace");

    // Then no command context can reach deterministic allow paths.
    expect(context).toBeUndefined();
  });

  test("resolves config self-protection from the actual bash workdir", async () => {
    // Given a protected policy beneath the execution cwd rather than the plugin workspace root.
    const policyPath = "/workspace/nested/command-approval.jsonc";
    const hook = createHook("/workspace", { loadedPolicy: loadedPolicy(policyPath) });

    // When a relative shell redirection targets that policy from args.workdir.
    const execution = hook(
      { tool: "bash", sessionID: "parent", callID: "call" },
      { args: {
        command: "printf x > command-approval.jsonc",
        description: "Overwrite nested approval policy",
        workdir: "./nested",
      } },
    );

    // Then self-protection blocks at its own stage instead of reviewing from the workspace cwd.
    await expect(execution).rejects.toMatchObject({
      name: "CommandApprovalError",
      verdict: {
        source: "rule",
        categories: [{ id: "security.config_self_protection", score: 1 }],
      },
    });
  });
});
