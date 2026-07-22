import { describe, expect, test } from "bun:test";
import { createMonotonicDeadline } from "../src/bounded-race";
import { reviewWithOpenCode } from "../src/opencode-reviewer";
import type { OpenCodeCallResult } from "../src/opencode-client-adapter";
import type { SerializeReviewRequestInput } from "../src/review-request";
import { expectedAgentFixture, validCreatedSession } from "./fixtures/opencode-review-fixtures";
import { reviewRuntimeFixture } from "./fixtures/opencode-review-runtime";

const request: SerializeReviewRequestInput = {
  context: { sessionID: "parent-session", tool: "bash", command: "echo ok", cwd: "/workspace", args: {} },
  shellAnalysis: { source: "echo ok", segments: [], redirections: [], staticFileReferences: [], issues: [], nestedAnalyses: [] },
  evaluation: { decision: "review", matchedRules: [], categories: [], reasons: [] },
  tirith: { action: "allow" },
  transcript: { status: "disabled" },
};

describe("direct OpenCode reviewer races", () => {
  test("revokes, aborts, drains, and deletes after prompt timeout", async () => {
    // Given a valid child whose prompt remains pending until exact abort.
    const agent = expectedAgentFixture();
    let settlePrompt: ((value: OpenCodeCallResult) => void) | undefined;
    let completedSetupCalls = 0;
    const prompt = new Promise<OpenCodeCallResult>((resolve) => { settlePrompt = resolve; });
    const fixture = reviewRuntimeFixture(async (method) => {
      if (method === "agents") {
        completedSetupCalls += 1;
        return { ok: true, data: [agent.runtime] };
      }
      if (method === "create") {
        completedSetupCalls += 1;
        return { ok: true, data: validCreatedSession() };
      }
      if (method === "prompt") return prompt;
      if (method === "abort") { settlePrompt?.({ ok: false, code: "transport_error" }); return { ok: true, data: true }; }
      if (method === "delete") return { ok: true, data: true };
      return { ok: false, code: "sdk_error" };
    });

    // When the supported minimum deadline deterministically leaves one millisecond for the pending prompt.
    const deadline = createMonotonicDeadline(5_000, () => completedSetupCalls >= 3 ? 4_999 : 0);
    const response = await reviewWithOpenCode(fixture.runtime, {
      parentSessionID: "parent-session", deadline, request,
    });

    // Then the immutable denial and one ordered abnormal cleanup sequence remain.
    expect(response.outcome).toBe("deny");
    expect(fixture.calls.map((call) => call.method)).toEqual([
      "agents", "create", "agents", "prompt", "abort", "delete",
    ]);
    expect(fixture.revocations).toEqual([{ sessionID: "child-session", generation: 1 }]);
  });

  test("cleans and logs a late create without changing the returned denial", async () => {
    // Given a create request retained beyond the exhausted caller deadline.
    const agent = expectedAgentFixture();
    let settleCreate: ((value: OpenCodeCallResult) => void) | undefined;
    let logObserved: (() => void) | undefined;
    const created = new Promise<OpenCodeCallResult>((resolve) => { settleCreate = resolve; });
    const logged = new Promise<void>((resolve) => { logObserved = resolve; });
    const fixture = reviewRuntimeFixture(async (method) => {
      if (method === "agents") return { ok: true, data: [agent.runtime] };
      if (method === "create") return created;
      if (method === "delete") return { ok: true, data: true };
      if (method === "log") { logObserved?.(); return { ok: true, data: true }; }
      return { ok: false, code: "sdk_error" };
    });

    // When create times out, returns denial, and later settles with an exact child.
    const response = await reviewWithOpenCode(fixture.runtime, {
      parentSessionID: "parent-session", deadline: createMonotonicDeadline(3), request,
    });
    settleCreate?.({ ok: true, data: validCreatedSession() });
    await logged;

    // Then late work performs exact delete plus allowlisted log without activation or verdict mutation.
    expect(response.outcome).toBe("deny");
    expect(fixture.calls.map((call) => call.method)).toEqual(["agents", "create", "delete", "log"]);
    expect(fixture.activations).toEqual([]);
    expect(fixture.calls.at(-1)?.input).toEqual({
      directory: "/workspace",
      service: "opencode-smart-approval",
      level: "warn",
      message: "review.late_create_cleanup",
      extra: { event: "late_create", child_id: "child-session", result: "success" },
      signal: expect.any(AbortSignal),
    });
  });

  test("starts no SDK call after budget exhaustion", async () => {
    // Given an already exhausted monotonic deadline.
    const fixture = reviewRuntimeFixture(async () => ({ ok: false, code: "sdk_error" }));
    let now = 10;
    const deadline = createMonotonicDeadline(1, () => now);
    now = 12;

    // When review attempts its first ordinary call.
    const response = await reviewWithOpenCode(fixture.runtime, { parentSessionID: "parent-session", deadline, request });

    // Then it fails closed before touching the adapter.
    expect(response.outcome).toBe("deny");
    expect(fixture.calls).toEqual([]);
  });
});
