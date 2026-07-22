import { describe, expect, test } from "bun:test";
import { createReviewHandle } from "../src/review-handle";
import type { OpenCodeCallResult } from "../src/opencode-client-adapter";

const success = async (): Promise<OpenCodeCallResult> => ({ ok: true, data: true });

describe("owned review handle states", () => {
  test("runs one normal exact delete after prompt settlement", async () => {
    // Given one active owned child with cleanup enabled.
    const calls: string[] = [];
    const handle = createReviewHandle({
      childID: "child", directory: "/workspace", cleanupEnabled: true,
      revoke: () => { calls.push("revoke"); return true; },
      abort: async () => { calls.push("abort"); return success(); },
      delete: async () => { calls.push("delete"); return success(); },
    });
    expect(handle.activate({ sessionID: "child", generation: 1 })).toBe(true);

    // When the prompt settles and normal cleanup runs.
    expect(handle.settlePrompt()).toBe(true);
    const result = await handle.cleanup(false);

    // Then the lease is revoked before one delete and abort is skipped.
    expect(result).toEqual({ ok: true, code: "deleted" });
    expect(calls).toEqual(["revoke", "delete"]);
    expect(handle.snapshot()).toEqual({
      state: "deleted", promptSettled: true, externalDeletedObserved: false,
      hasLease: false, hasCleanupPromise: true,
      hasPromptSettlement: false, hasTerminalListener: false,
    });
  });

  test("retains an ordinary inactive child only when cleanup is disabled", async () => {
    // Given an opt-out handle whose prompt has settled.
    let deletes = 0;
    const handle = createReviewHandle({
      childID: "child", directory: "/workspace", cleanupEnabled: false,
      revoke: () => true, abort: success,
      delete: async () => { deletes += 1; return success(); },
    });
    handle.activate({ sessionID: "child", generation: 1 });
    handle.settlePrompt();

    // When ordinary cleanup is requested.
    const result = await handle.cleanup(false);

    // Then the exact child remains retained without lifecycle calls.
    expect(result).toEqual({ ok: true, code: "retained" });
    expect(deletes).toBe(0);
    expect(handle.snapshot().state).toBe("retained");
  });

  test("keeps terminal states immutable", async () => {
    // Given a normally deleted handle.
    const handle = createReviewHandle({
      childID: "child", directory: "/workspace", cleanupEnabled: true,
      revoke: () => true, abort: success, delete: success,
    });
    await handle.cleanup(true);
    const terminal = handle.snapshot();

    // When every later mutation is attempted.
    const mutations = [
      handle.activate({ sessionID: "child", generation: 1 }),
      handle.setPromptSettlement(Promise.resolve()),
      handle.settlePrompt(),
      handle.observeDeleted(),
    ];
    const joined = await handle.cleanup(true);

    // Then no transition leaves the terminal state and cleanup joins its result.
    expect(mutations).toEqual([false, false, false, false]);
    expect(joined).toEqual({ ok: true, code: "deleted" });
    expect(handle.snapshot()).toEqual(terminal);
  });
});
