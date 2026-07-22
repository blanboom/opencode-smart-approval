import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { createMonotonicDeadline } from "../src/bounded-race";
import type { OpenCodeCallResult } from "../src/opencode-client-adapter";
import { reviewWithOpenCode } from "../src/opencode-reviewer";
import type { SerializeReviewRequestInput } from "../src/review-request";
import {
  expectedAgentFixture,
  validCreatedSession,
  validPromptResponse,
} from "./fixtures/opencode-review-fixtures";
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

const denyVerdict = () => ({
  outcome: "deny",
  risk_level: "critical",
  user_authorization: "low",
  categories: [{ id: "security.model_denied", score: 0.8 }],
  reasons: ["primary model denial"],
});

type LifecycleOperation = () => Promise<OpenCodeCallResult>;
type CleanupScenario = {
  readonly deleteOperation: LifecycleOperation;
  readonly advanceMs: 0 | 2_000;
  readonly rejectLate?: () => void;
};

const timeoutScenario = (): CleanupScenario => {
  let rejectDelete: ((reason: Error) => void) | undefined;
  const pending = new Promise<OpenCodeCallResult>((_resolve, reject) => { rejectDelete = reject; });
  return {
    deleteOperation: () => pending,
    advanceMs: 2_000,
    rejectLate: () => rejectDelete?.(new Error("late private delete rejection")),
  };
};

const CLEANUP_FAILURE_CASES: readonly (readonly [string, 0 | 2_000, () => CleanupScenario])[] = [
  ["false result", 0, () => ({
    deleteOperation: async () => ({ ok: false, code: "false_result" }), advanceMs: 0,
  })],
  ["SDK error", 0, () => ({
    deleteOperation: async () => ({ ok: false, code: "sdk_error" }), advanceMs: 0,
  })],
  ["transport rejection", 0, () => ({
    deleteOperation: async () => { throw new Error("private transport rejection"); }, advanceMs: 0,
  })],
  ["timeout", 2_000, timeoutScenario],
];

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const runCleanupFailure = async (verdict: unknown, createScenario: () => CleanupScenario) => {
  const scenario = createScenario();
  const agent = expectedAgentFixture();
  const unhandled: unknown[] = [];
  const observeUnhandled = (reason: unknown) => { unhandled.push(reason); };
  let observeDelete: (() => void) | undefined;
  const deleteStarted = new Promise<void>((resolve) => { observeDelete = resolve; });
  process.on("unhandledRejection", observeUnhandled);
  try {
    const fixture = reviewRuntimeFixture(async (method) => {
      if (method === "agents") return { ok: true, data: [agent.runtime] };
      if (method === "create") return { ok: true, data: validCreatedSession() };
      if (method === "prompt") return { ok: true, data: validPromptResponse(verdict) };
      if (method === "delete") { observeDelete?.(); return scenario.deleteOperation(); }
      return { ok: false, code: "sdk_error" };
    });
    const responsePending = reviewWithOpenCode(fixture.runtime, {
      parentSessionID: "parent-session", deadline: createMonotonicDeadline(5_000), request,
    });
    await deleteStarted;
    const virtualStart = Date.now();
    if (scenario.advanceMs > 0) jest.advanceTimersByTime(scenario.advanceMs);
    const response = await responsePending;
    const virtualElapsed = Date.now() - virtualStart;
    const methods = fixture.calls.map((call) => call.method);
    const snapshot = fixture.runtime.registry.get("child-session")?.snapshot();
    const serialized = JSON.stringify(response);
    scenario.rejectLate?.();
    await flushMicrotasks();
    return {
      response,
      methods,
      activations: fixture.activations.length,
      revocations: fixture.revocations.length,
      snapshot,
      virtualElapsed,
      unhandled,
      unchanged: serialized === JSON.stringify(response)
        && methods.join(",") === fixture.calls.map((call) => call.method).join(",")
        && snapshot?.state === fixture.runtime.registry.get("child-session")?.snapshot().state,
    };
  } finally {
    process.off("unhandledRejection", observeUnhandled);
  }
};

describe("normal reviewer cleanup result projection", () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test.each(CLEANUP_FAILURE_CASES)("preserves allow evidence after delete %s", async (
    _label,
    expectedAdvance,
    createScenario,
  ) => {
    // Given a valid model allow followed by one required exact-delete failure.
    const result = await runCleanupFailure(undefined, createScenario);

    // When the public reviewer projects the terminal cleanup result.
    const serialized = JSON.stringify(result.response);

    // Then it denies with the original evidence plus one centralized lifecycle marker and no private detail.
    expect(result).toEqual({
      response: {
        outcome: "deny", riskLevel: "high", userAuthorization: "unknown",
        categories: [
          { id: "security.reviewed", score: 0.1 },
          { id: "security.reviewer_lifecycle", score: 1 },
        ],
        reasons: ["bounded command", "reviewer_lifecycle:delete_failed"],
      },
      methods: ["agents", "create", "agents", "prompt", "delete"],
      activations: 1,
      revocations: 1,
      snapshot: {
        state: "cleanup_failed", promptSettled: true, externalDeletedObserved: false,
        hasLease: false, hasCleanupPromise: false,
        hasPromptSettlement: false, hasTerminalListener: true,
      },
      virtualElapsed: expectedAdvance,
      unhandled: [],
      unchanged: true,
    });
    expect(serialized).not.toMatch(/private|sdk_error|transport_error|false_result|timeout/u);
  });

  test.each(CLEANUP_FAILURE_CASES)("preserves primary deny evidence after delete %s", async (
    _label,
    expectedAdvance,
    createScenario,
  ) => {
    // Given a valid model deny followed by one required exact-delete failure.
    const result = await runCleanupFailure(denyVerdict(), createScenario);

    // When the public reviewer projects the terminal cleanup result.
    const serialized = JSON.stringify(result.response);

    // Then primary denial stays intact beside only one centralized lifecycle category and reason.
    expect(result).toEqual({
      response: {
        outcome: "deny", riskLevel: "critical", userAuthorization: "low",
        categories: [
          { id: "security.model_denied", score: 0.8 },
          { id: "security.reviewer_lifecycle", score: 1 },
        ],
        reasons: ["primary model denial", "reviewer_lifecycle:delete_failed"],
      },
      methods: ["agents", "create", "agents", "prompt", "delete"],
      activations: 1,
      revocations: 1,
      snapshot: {
        state: "cleanup_failed", promptSettled: true, externalDeletedObserved: false,
        hasLease: false, hasCleanupPromise: false,
        hasPromptSettlement: false, hasTerminalListener: true,
      },
      virtualElapsed: expectedAdvance,
      unhandled: [],
      unchanged: true,
    });
    expect(serialized).not.toMatch(/private|sdk_error|transport_error|false_result|timeout/u);
  });
});
