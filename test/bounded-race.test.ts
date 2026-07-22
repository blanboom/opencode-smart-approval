import { describe, expect, test } from "bun:test";
import { createMonotonicDeadline, runBoundedCall, type LateSettlement } from "../src/bounded-race";

describe("bounded monotonic call race", () => {
  test("does not start after the overall deadline is exhausted", async () => {
    // Given a deadline whose monotonic clock has already advanced beyond expiry.
    let now = 10;
    const deadline = createMonotonicDeadline(5, () => now);
    now = 16;
    let calls = 0;

    // When a bounded call is requested.
    const result = await runBoundedCall({
      deadline,
      timeoutMs: 20,
      operation: async () => { calls += 1; return "unexpected"; },
    });

    // Then the operation never starts.
    expect(result).toEqual({ ok: false, code: "exhausted" });
    expect(calls).toBe(0);
  });

  test("returns fulfilled data before the sublimit", async () => {
    // Given a live overall deadline and immediate operation.
    const deadline = createMonotonicDeadline(1_000);

    // When the operation settles before either bound.
    const result = await runBoundedCall({ deadline, timeoutMs: 100, operation: async () => "value" });

    // Then the value is returned unchanged.
    expect(result).toEqual({ ok: true, value: "value" });
  });

  test("aborts at the smaller bound and sinks a late fulfillment", async () => {
    // Given an operation retained beyond a one-millisecond sublimit.
    let resolveOperation: ((value: string) => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    const operation = new Promise<string>((resolve) => { resolveOperation = resolve; });
    const late: LateSettlement<string>[] = [];

    // When the timeout wins and the operation later fulfills.
    const result = await runBoundedCall({
      deadline: createMonotonicDeadline(1_000),
      timeoutMs: 1,
      operation: async (signal) => { observedSignal = signal; return operation; },
      onLateSettlement: (settlement) => { late.push(settlement); },
    });
    resolveOperation?.("late");
    await Promise.resolve();
    await Promise.resolve();

    // Then the caller is immutable, the signal is aborted, and the fulfillment is observed once.
    expect(result).toEqual({ ok: false, code: "timeout" });
    expect(observedSignal?.aborted).toBe(true);
    expect(late).toEqual([{ status: "fulfilled", value: "late" }]);
  });

  test("normalizes early and late rejection without exposing reasons", async () => {
    // Given one immediate rejection and one rejection retained beyond timeout.
    let rejectOperation: (() => void) | undefined;
    const retained = new Promise<string>((_resolve, reject) => { rejectOperation = () => reject(new Error("private")); });
    const late: LateSettlement<string>[] = [];

    // When both calls cross the race boundary.
    const early = await runBoundedCall({
      deadline: createMonotonicDeadline(1_000),
      timeoutMs: 100,
      operation: async () => { throw new Error("private"); },
    });
    const pending = runBoundedCall({
      deadline: createMonotonicDeadline(1_000), timeoutMs: 1,
      operation: async () => retained,
      onLateSettlement: (settlement) => { late.push(settlement); },
    });
    const timedOut = await pending;
    rejectOperation?.();
    await Promise.resolve();
    await Promise.resolve();

    // Then only fixed classifications leave the helper and the late rejection is settled.
    expect(early).toEqual({ ok: false, code: "rejected" });
    expect(timedOut).toEqual({ ok: false, code: "timeout" });
    expect(late).toEqual([{ status: "rejected" }]);
  });
});
