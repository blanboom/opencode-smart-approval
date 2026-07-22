import { describe, expect, test } from "bun:test";
import { createReviewHandle } from "../src/review-handle";
import type { OpenCodeCallResult } from "../src/opencode-client-adapter";

const ok = (): OpenCodeCallResult => ({ ok: true, data: true });
const failed = (): OpenCodeCallResult => ({ ok: false, code: "false_result" });

describe("owned review cleanup races", () => {
  test("revokes, aborts, drains, and deletes once for concurrent abnormal cleanup", async () => {
    // Given an active child with a pending prompt and lifecycle call captures.
    const calls: string[] = [];
    let settlePrompt: (() => void) | undefined;
    const prompt = new Promise<void>((resolve) => { settlePrompt = resolve; });
    const handle = createReviewHandle({
      childID: "child", directory: "/workspace", cleanupEnabled: false,
      revoke: () => { calls.push("revoke"); return true; },
      abort: async () => { calls.push("abort"); settlePrompt?.(); return ok(); },
      delete: async () => { calls.push("delete"); return ok(); },
    });
    handle.activate({ sessionID: "child", generation: 1 });
    handle.setPromptSettlement(prompt);

    // When duplicate abnormal triggers race.
    const first = handle.cleanup(true);
    const second = handle.cleanup(true);
    const results = await Promise.all([first, second]);

    // Then callers join the same promise and issue one ordered sequence despite opt-out.
    expect(first).toBe(second);
    expect(results).toEqual([{ ok: true, code: "deleted" }, { ok: true, code: "deleted" }]);
    expect(calls).toEqual(["revoke", "abort", "delete"]);
  });

  test("still deletes but reports abort false as lifecycle failure", async () => {
    // Given an active prompt whose abort returns false.
    const calls: string[] = [];
    const handle = createReviewHandle({
      childID: "child", directory: "/workspace", cleanupEnabled: true,
      revoke: () => { calls.push("revoke"); return true; },
      abort: async () => { calls.push("abort"); return failed(); },
      delete: async () => { calls.push("delete"); return ok(); },
    });
    handle.activate({ sessionID: "child", generation: 1 });
    handle.setPromptSettlement(new Promise(() => undefined));

    // When abnormal cleanup runs.
    const result = await handle.cleanup(true);

    // Then exact deletion still occurs but authorization sees the abort failure.
    expect(result).toEqual({ ok: false, code: "abort_failed", failure: "error" });
    expect(calls).toEqual(["revoke", "abort", "delete"]);
    expect(handle.snapshot().state).toBe("deleted");
  });

  test("accepts delete false only after the exact external deletion race", async () => {
    // Given two inactive children whose delete calls return false.
    const withoutEvent = createReviewHandle({
      childID: "first", directory: "/workspace", cleanupEnabled: true,
      revoke: () => true, abort: async () => ok(), delete: async () => failed(),
    });
    let withEvent: ReturnType<typeof createReviewHandle>;
    withEvent = createReviewHandle({
      childID: "second", directory: "/workspace", cleanupEnabled: true,
      revoke: () => true, abort: async () => ok(),
      delete: async () => { withEvent.observeDeleted(); return failed(); },
    });

    // When cleanup observes no event versus an exact concurrent event.
    const results = await Promise.all([withoutEvent.cleanup(true), withEvent.cleanup(true)]);

    // Then only the exact observed-deletion race converts false to success.
    expect(results).toEqual([
      { ok: false, code: "delete_failed", failure: "error" },
      { ok: true, code: "already_deleted" },
    ]);
  });

  test("retries a settled delete failure while sharing each in-flight attempt", async () => {
    // Given one owned child whose first exact delete fails transiently.
    let deleteCalls = 0;
    const handle = createReviewHandle({
      childID: "child", directory: "/workspace", cleanupEnabled: true,
      revoke: () => true, abort: async () => ok(),
      delete: async () => { deleteCalls += 1; return deleteCalls === 1 ? failed() : ok(); },
    });
    const first = await handle.cleanup(true);

    // When two later cleanup readers retry concurrently.
    const second = handle.cleanup(true);
    const joined = handle.cleanup(true);
    const retryResults = await Promise.all([second, joined]);

    // Then the failed attempt is not memoized, while the retry remains single-flight and converges.
    expect(first).toEqual({ ok: false, code: "delete_failed", failure: "error" });
    expect(second).toBe(joined);
    expect(retryResults).toEqual([{ ok: true, code: "deleted" }, { ok: true, code: "deleted" }]);
    expect(deleteCalls).toBe(2);
    expect(handle.snapshot().state).toBe("deleted");
  });

  test("converges a failed delete after an exact external deletion observation", async () => {
    // Given one owned child after an exact delete attempt failed.
    const handle = createReviewHandle({
      childID: "child", directory: "/workspace", cleanupEnabled: true,
      revoke: () => true, abort: async () => ok(), delete: async () => failed(),
    });
    await handle.cleanup(true);

    // When the host later reports deletion of that exact child.
    const observed = handle.observeDeleted();

    // Then the active reader converges to deleted instead of remaining permanently failed.
    expect(observed).toBe(true);
    expect(handle.snapshot().state).toBe("deleted");
    expect(await handle.cleanup(true)).toEqual({ ok: true, code: "already_deleted" });
  });
});
