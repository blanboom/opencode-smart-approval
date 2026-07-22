import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { OpenCodeCallResult } from "../src/opencode-client-adapter";
import { flushMicrotasks, startPromptFailure } from "./fixtures/opencode-prompt-cleanup";

describe("prompt failure drain result projection", () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test("waits for prompt drain after abort true before exact deletion", async () => {
    // Given a timed-out prompt and successful abort whose prompt settlement is still pending.
    let settlePrompt: ((value: OpenCodeCallResult) => void) | undefined;
    let promptObserved: (() => void) | undefined;
    let abortObserved: (() => void) | undefined;
    const prompt = new Promise<OpenCodeCallResult>((resolve) => { settlePrompt = resolve; });
    const promptStarted = new Promise<void>((resolve) => { promptObserved = resolve; });
    const abortStarted = new Promise<void>((resolve) => { abortObserved = resolve; });
    const started = startPromptFailure({
      prompt,
      abortOperation: async () => ({ ok: true, data: true }),
      observePrompt: () => promptObserved?.(),
      observeAbort: () => abortObserved?.(),
    });

    // When prompt timeout and abort complete but the drain has not settled.
    await promptStarted;
    jest.advanceTimersByTime(1);
    await abortStarted;
    await flushMicrotasks();

    // Then delete waits for drain, and settlement permits exactly one delete with the primary denial unchanged.
    expect(started.fixture.calls.map((call) => call.method)).toEqual(["agents", "create", "agents", "prompt", "abort"]);
    settlePrompt?.({ ok: false, code: "transport_error" });
    expect(await started.response).toEqual({
      outcome: "deny", riskLevel: "high", userAuthorization: "unknown",
      categories: [{ id: "security.reviewer_unavailable", score: 1 }],
      reasons: ["reviewer_failure:prompt_failed"],
    });
    expect(started.fixture.calls.map((call) => call.method)).toEqual([
      "agents", "create", "agents", "prompt", "abort", "delete",
    ]);
    expect(started.fixture.activations).toHaveLength(1);
    expect(started.fixture.revocations).toHaveLength(1);
  });

  test("denies after fixed prompt drain timeout and sinks late rejection", async () => {
    // Given abort succeeds while the timed-out prompt remains pending through its drain bound.
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
        abortOperation: async () => ({ ok: true, data: true }),
        observePrompt: () => promptObserved?.(),
        observeAbort: () => abortObserved?.(),
      });
      const virtualStart = Date.now();

      // When prompt timeout, abort, and the fixed 5000 ms virtual drain bound expire.
      await promptStarted;
      jest.advanceTimersByTime(1);
      await abortStarted;
      await flushMicrotasks();
      jest.advanceTimersByTime(5_000);
      const response = await started.response;
      const serialized = JSON.stringify(response);
      const methods = started.fixture.calls.map((call) => call.method);
      const snapshot = started.fixture.runtime.registry.get("child-session")?.snapshot();
      rejectPrompt?.(new Error("late private drain rejection"));
      await flushMicrotasks();

      // Then drain failure cannot authorize or leak, and late settlement cannot mutate terminal evidence/state.
      expect(response).toEqual({
        outcome: "deny", riskLevel: "high", userAuthorization: "unknown",
        categories: [
          { id: "security.reviewer_unavailable", score: 1 },
          { id: "security.reviewer_lifecycle", score: 1 },
        ],
        reasons: ["reviewer_failure:prompt_failed", "reviewer_lifecycle:drain_failed"],
      });
      expect(methods).toEqual(["agents", "create", "agents", "prompt", "abort", "delete"]);
      expect(started.fixture.calls.map((call) => call.method)).toEqual(methods);
      expect(Date.now() - virtualStart).toBe(5_001);
      expect(started.fixture.activations).toHaveLength(1);
      expect(started.fixture.revocations).toHaveLength(1);
      expect(snapshot).toBeUndefined();
      expect(started.fixture.runtime.registry.get("child-session")?.snapshot()).toEqual(snapshot);
      expect(JSON.stringify(response)).toBe(serialized);
      expect(serialized).not.toMatch(/private|sdk_error|transport_error|false_result|timeout/u);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });
});
