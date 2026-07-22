import { describe, expect, test } from "bun:test";
import { createReviewHandle } from "../src/review-handle";
import { createReviewRegistry } from "../src/review-registry";

const handleFor = (childID: string, cleanupEnabled = true) => createReviewHandle({
  childID,
  directory: "/workspace",
  cleanupEnabled,
  revoke: () => true,
  abort: async () => ({ ok: true, data: true }),
  delete: async () => ({ ok: true, data: true }),
});

describe("owned review registry events", () => {
  test("gates idle and deleted events by exact ownership and directory", async () => {
    // Given one exact in-memory owned handle.
    const registry = createReviewRegistry();
    const handle = handleFor("child");
    registry.add(handle);

    // When mismatched and exact events arrive.
    const mismatches = await Promise.all([
      registry.idle("other", "/workspace"),
      registry.idle("child", "/other"),
    ]);
    const deletedMismatch = registry.deleted("other", "/workspace");
    const exact = registry.deleted("child", "/workspace");

    // Then only the exact event can mutate the owned handle.
    expect(mismatches).toEqual([undefined, undefined]);
    expect([deletedMismatch, exact]).toEqual([false, true]);
    expect(handle.snapshot().state).toBe("deleted");
  });

  test("idle joins cleanup while retained opt-out remains retained", async () => {
    // Given cleanup-enabled and retained-opt-out owned children.
    const registry = createReviewRegistry();
    const enabled = handleFor("enabled");
    const retained = handleFor("retained", false);
    registry.add(enabled);
    registry.add(retained);

    // When child-idle is observed repeatedly.
    const results = await Promise.all([
      registry.idle("enabled", "/workspace"),
      registry.idle("enabled", "/workspace"),
      registry.idle("retained", "/workspace"),
    ]);

    // Then enabled cleanup joins and opt-out performs no delete.
    expect(results).toEqual([
      { ok: true, code: "deleted" },
      { ok: true, code: "deleted" },
      { ok: true, code: "retained" },
    ]);
    expect(retained.snapshot().state).toBe("retained");
  });

  test("instance disposal abnormally cleans retained and active children", async () => {
    // Given two owned children including cleanup opt-out.
    const registry = createReviewRegistry();
    const first = handleFor("first", false);
    const second = handleFor("second", true);
    registry.add(first);
    registry.add(second);

    // When matching instance disposal runs twice.
    const firstResults = await registry.dispose("/workspace");
    const secondResults = await registry.dispose("/workspace");

    // Then abnormal cleanup overrides opt-out and terminal ownership is evicted.
    expect(firstResults).toEqual([{ ok: true, code: "deleted" }, { ok: true, code: "deleted" }]);
    expect(secondResults).toEqual([]);
    expect([first.snapshot().state, second.snapshot().state]).toEqual(["deleted", "deleted"]);
  });

  test("evicts terminal ownership while an acquired reader remains valid", async () => {
    // Given a registered active child with a captured prompt settlement and reader.
    const registry = createReviewRegistry();
    const handle = handleFor("child");
    handle.activate({ sessionID: "child", generation: 1 });
    handle.setPromptSettlement(Promise.resolve({ payload: "private response" }));
    registry.add(handle);
    const acquired = registry.get("child");

    // When the exact idle event settles and deletes the child.
    const result = await registry.idle("child", "/workspace");

    // Then registry ownership and retained callbacks are gone, while the acquired reader sees terminal state.
    expect(result).toEqual({ ok: true, code: "deleted" });
    expect(registry.get("child")).toBeUndefined();
    expect(acquired?.snapshot()).toMatchObject({
      state: "deleted", hasPromptSettlement: false, hasTerminalListener: false,
    });
    expect(registry.add(handleFor("child"))).toBe(true);
  });

  test("retains a failed delete for one later disposal retry and then evicts it", async () => {
    // Given a registered child whose first delete fails and second delete succeeds.
    const registry = createReviewRegistry();
    let deleteCalls = 0;
    const handle = createReviewHandle({
      childID: "child", directory: "/workspace", cleanupEnabled: true,
      revoke: () => true, abort: async () => ({ ok: true, data: true }),
      delete: async () => {
        deleteCalls += 1;
        return deleteCalls === 1 ? { ok: false, code: "false_result" } : { ok: true, data: true };
      },
    });
    registry.add(handle);
    const failedCleanup = await registry.idle("child", "/workspace");

    // When later instance disposal retries the still-owned child.
    const retried = await registry.dispose("/workspace");

    // Then one retry converges, evicts registry ownership, and preserves the acquired reader.
    expect(failedCleanup).toEqual({ ok: false, code: "delete_failed", failure: "error" });
    expect(retried).toEqual([{ ok: true, code: "deleted" }]);
    expect(deleteCalls).toBe(2);
    expect(registry.get("child")).toBeUndefined();
    expect(handle.snapshot().state).toBe("deleted");
  });
});
