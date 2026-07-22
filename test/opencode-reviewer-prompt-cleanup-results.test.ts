import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { OpenCodeCallResult } from "../src/opencode-client-adapter";
import {
  flushMicrotasks,
  type LifecycleOperation,
  startPromptFailure,
} from "./fixtures/opencode-prompt-cleanup";
type AbortScenario = {
  readonly abortOperation: LifecycleOperation;
  readonly advanceMs: 0 | 2_000;
  readonly rejectLate?: () => void;
};

const timeoutAbort = (): AbortScenario => {
  let rejectAbort: ((reason: Error) => void) | undefined;
  const pending = new Promise<OpenCodeCallResult>((_resolve, reject) => { rejectAbort = reject; });
  return {
    abortOperation: () => pending,
    advanceMs: 2_000,
    rejectLate: () => rejectAbort?.(new Error("late private abort rejection")),
  };
};

const ABORT_FAILURE_CASES: readonly (readonly [string, 0 | 2_000, () => AbortScenario])[] = [
  ["false result", 0, () => ({
    abortOperation: async () => ({ ok: false, code: "false_result" }), advanceMs: 0,
  })],
  ["SDK error", 0, () => ({
    abortOperation: async () => ({ ok: false, code: "sdk_error" }), advanceMs: 0,
  })],
  ["transport rejection", 0, () => ({
    abortOperation: async () => { throw new Error("private abort rejection"); }, advanceMs: 0,
  })],
  ["timeout", 2_000, timeoutAbort],
];

const runAbortFailure = async (createScenario: () => AbortScenario) => {
  const scenario = createScenario();
  const unhandled: unknown[] = [];
  const observeUnhandled = (reason: unknown) => { unhandled.push(reason); };
  let rejectPrompt: ((reason: Error) => void) | undefined;
  let promptObserved: (() => void) | undefined;
  let abortObserved: (() => void) | undefined;
  const prompt = new Promise<OpenCodeCallResult>((_resolve, reject) => { rejectPrompt = reject; });
  const promptStarted = new Promise<void>((resolve) => { promptObserved = resolve; });
  const abortStarted = new Promise<void>((resolve) => { abortObserved = resolve; });
  process.on("unhandledRejection", observeUnhandled);
  try {
    const started = startPromptFailure({
      prompt,
      abortOperation: scenario.abortOperation,
      observePrompt: () => promptObserved?.(),
      observeAbort: () => abortObserved?.(),
    });
    const virtualStart = Date.now();
    await promptStarted;
    jest.advanceTimersByTime(1);
    await abortStarted;
    if (scenario.advanceMs > 0) jest.advanceTimersByTime(scenario.advanceMs);
    const response = await started.response;
    const methods = started.fixture.calls.map((call) => call.method);
    const snapshot = started.fixture.runtime.registry.get("child-session")?.snapshot();
    const serialized = JSON.stringify(response);
    rejectPrompt?.(new Error("late private prompt rejection"));
    scenario.rejectLate?.();
    await flushMicrotasks();
    return {
      response,
      methods,
      activations: started.fixture.activations.length,
      revocations: started.fixture.revocations.length,
      snapshot,
      virtualElapsed: Date.now() - virtualStart,
      unhandled,
      unchanged: serialized === JSON.stringify(response)
        && methods.join(",") === started.fixture.calls.map((call) => call.method).join(",")
        && snapshot?.state === started.fixture.runtime.registry.get("child-session")?.snapshot().state,
    };
  } finally {
    process.off("unhandledRejection", observeUnhandled);
  }
};

describe("prompt failure cleanup result projection", () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test.each(ABORT_FAILURE_CASES)("deletes after abort %s and preserves failure evidence", async (
    _label,
    abortAdvance,
    createScenario,
  ) => {
    // Given a timed-out prompt followed by one bounded abort failure.
    const result = await runAbortFailure(createScenario);

    // When abnormal cleanup projects the abort result after exact deletion.
    const serialized = JSON.stringify(result.response);

    // Then public denial gains one abort lifecycle marker without retry, resurrection, or private text.
    expect(result).toEqual({
      response: {
        outcome: "deny", riskLevel: "high", userAuthorization: "unknown",
        categories: [
          { id: "security.reviewer_unavailable", score: 1 },
          { id: "security.reviewer_lifecycle", score: 1 },
        ],
        reasons: ["reviewer_failure:prompt_failed", "reviewer_lifecycle:abort_failed"],
      },
      methods: ["agents", "create", "agents", "prompt", "abort", "delete"],
      activations: 1,
      revocations: 1,
      snapshot: undefined,
      virtualElapsed: 1 + abortAdvance,
      unhandled: [],
      unchanged: true,
    });
    expect(serialized).not.toMatch(/private|sdk_error|transport_error|false_result|timeout/u);
  });

});
