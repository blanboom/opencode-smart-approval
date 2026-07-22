import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { createMonotonicDeadline } from "../src/bounded-race";
import type { OpenCodeCallResult } from "../src/opencode-client-adapter";
import { reviewWithOpenCode } from "../src/opencode-reviewer";
import type { SerializeReviewRequestInput } from "../src/review-request";
import { expectedAgentFixture, validCreatedSession } from "./fixtures/opencode-review-fixtures";
import { reviewRuntimeFixture } from "./fixtures/opencode-review-runtime";

const request: SerializeReviewRequestInput = {
  context: { sessionID: "parent-session", tool: "bash", command: "echo ok", cwd: "/workspace", args: {} },
  shellAnalysis: {
    source: "echo ok", segments: [], redirections: [], staticFileReferences: [], issues: [], nestedAnalyses: [],
  },
  evaluation: { decision: "review", matchedRules: [], categories: [], reasons: [] },
  tirith: { action: "allow" },
  transcript: { status: "disabled" },
};

const unrelatedSession = () => ({
  ...validCreatedSession(),
  id: "unrelated-session",
  parentID: "unrelated-parent",
});

const flushMicrotasks = async (): Promise<void> => {
  for (let count = 0; count < 8; count += 1) await Promise.resolve();
};

describe("created review session identity ownership", () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test("does not delete an unrelated ID from an invalid immediate create identity", async () => {
    // Given create returns an exact string ID attached to a different parent identity.
    const agent = expectedAgentFixture();
    const fixture = reviewRuntimeFixture(async (method) => {
      if (method === "agents") return { ok: true, data: [agent.runtime] };
      if (method === "create") return { ok: true, data: unrelatedSession() };
      if (method === "delete") return { ok: true, data: true };
      return { ok: false, code: "sdk_error" };
    });

    // When the reviewer evaluates ownership before cleanup.
    const response = await reviewWithOpenCode(fixture.runtime, {
      parentSessionID: "parent-session", deadline: createMonotonicDeadline(5_000), request,
    });

    // Then it fails closed without claiming or deleting the unrelated ID.
    expect(response.reasons).toEqual(["reviewer_failure:invalid_session"]);
    expect(fixture.calls.map((call) => call.method)).toEqual(["agents", "create"]);
    expect(fixture.runtime.registry.get("unrelated-session")).toBeUndefined();
  });

  test("does not delete an unrelated ID from an invalid late create identity", async () => {
    // Given create times out and later settles with an ID attached to a different parent.
    const agent = expectedAgentFixture();
    let agentCompleted = false;
    let settleCreate: ((value: OpenCodeCallResult) => void) | undefined;
    let observeCreate: (() => void) | undefined;
    const created = new Promise<OpenCodeCallResult>((resolve) => { settleCreate = resolve; });
    const createStarted = new Promise<void>((resolve) => { observeCreate = resolve; });
    const fixture = reviewRuntimeFixture(async (method) => {
      if (method === "agents") { agentCompleted = true; return { ok: true, data: [agent.runtime] }; }
      if (method === "create") { observeCreate?.(); return created; }
      if (method === "delete" || method === "log") return { ok: true, data: true };
      return { ok: false, code: "sdk_error" };
    });
    const pending = reviewWithOpenCode(fixture.runtime, {
      parentSessionID: "parent-session",
      deadline: createMonotonicDeadline(5_000, () => agentCompleted ? 4_999 : 0),
      request,
    });

    // When the create bound expires before the unrelated response arrives.
    await createStarted;
    jest.advanceTimersByTime(1);
    const response = await pending;
    settleCreate?.({ ok: true, data: unrelatedSession() });
    await flushMicrotasks();

    // Then late settlement cannot establish ownership, delete, or emit cleanup diagnostics.
    expect(response.reasons).toEqual(["reviewer_failure:create_failed"]);
    expect(fixture.calls.map((call) => call.method)).toEqual(["agents", "create"]);
    expect(fixture.runtime.registry.get("unrelated-session")).toBeUndefined();
  });
});
