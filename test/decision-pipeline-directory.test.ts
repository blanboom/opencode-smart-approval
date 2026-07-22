import { describe, expect, test } from "bun:test";
import { defaultPolicy } from "../src/default-config";
import { resolveCommandVerdict } from "../src/decision-pipeline";
import { analyzeShell } from "../src/shell-analysis";
import type { CommandContext } from "../src/types";
import { reviewRuntimeFixture } from "./fixtures/opencode-review-runtime";
import { expectedAgentFixture, validCreatedSession, validPromptResponse } from "./fixtures/opencode-review-fixtures";

const objectField = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

const context: CommandContext = {
  sessionID: "parent-session",
  tool: "bash",
  command: "scanner-allow",
  cwd: "/workspace/.",
  args: { command: "scanner-allow" },
};

describe("decision pipeline directory invariant", () => {
  test("fails closed before transcript or reviewer calls when execution cwd is not canonical", async () => {
    // Given a noncanonical execution cwd and a canonical reviewer workspace directory.
    const fixture = reviewRuntimeFixture(async (method) => {
      if (method === "messages") return { ok: true, data: [] };
      return { ok: false, code: "sdk_error" };
    });
    const policy = {
      ...defaultPolicy(),
      tirith: { enabled: false, timeoutMs: 5_000, failOpen: false },
      rules: [],
    };
    const analysis = await analyzeShell(context.command, context.cwd);

    // When the command reaches the contextual approval boundary.
    const verdict = await resolveCommandVerdict({
      policy,
      context,
      reviewerRuntime: fixture.runtime,
      analysis,
      forceReview: false,
    });

    // Then the malformed execution cwd is denied before transcript, root calls, or lease activation.
    expect(verdict).toMatchObject({ decision: "block", source: "fail_closed" });
    expect(verdict.reasons).toContain("reviewer_failure:directory_mismatch");
    expect(fixture.calls).toEqual([]);
    expect(fixture.activations).toEqual([]);
  });

  test("keeps the reviewer workspace separate from a canonical execution cwd", async () => {
    // Given a reviewer rooted at the workspace and a command that executes in its nested workdir.
    const expected = expectedAgentFixture();
    const fixture = reviewRuntimeFixture(async (method) => {
      if (method === "messages") return { ok: true, data: [] };
      if (method === "agents") return { ok: true, data: [expected.runtime] };
      if (method === "create") return { ok: true, data: validCreatedSession() };
      if (method === "prompt") return { ok: true, data: validPromptResponse() };
      if (method === "delete") return { ok: true, data: true };
      return { ok: false, code: "sdk_error" };
    });
    const nestedContext: CommandContext = {
      sessionID: "parent-session",
      tool: "bash",
      command: "scanner-allow",
      cwd: "/workspace/execution",
      args: { command: "scanner-allow", description: "Run scanner", workdir: "./execution" },
    };
    const policy = {
      ...defaultPolicy(),
      tirith: { enabled: false, timeoutMs: 5_000, failOpen: false },
      rules: [],
    };
    const analysis = await analyzeShell(nestedContext.command, nestedContext.cwd);

    // When the command reaches the OpenCode reviewer.
    const verdict = await resolveCommandVerdict({
      policy,
      context: nestedContext,
      reviewerRuntime: fixture.runtime,
      analysis,
      forceReview: false,
    });

    // Then API calls remain workspace-scoped while the machine review request uses execution cwd.
    expect(verdict).toMatchObject({ decision: "allow", source: "review" });
    expect(fixture.calls.map((call) => objectField(call.input, "directory"))).toEqual(
      fixture.calls.map(() => "/workspace"),
    );
    const prompt = fixture.calls.find((call) => call.method === "prompt");
    const promptText = prompt ? objectField(prompt.input, "text") : undefined;
    const text = typeof promptText === "string" ? promptText : undefined;
    expect(text === undefined ? undefined : JSON.parse(text)).toMatchObject({
      cwd: "/workspace/execution",
      args: nestedContext.args,
    });
  });
});
