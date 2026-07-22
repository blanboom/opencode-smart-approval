import { describe, expect, test } from "bun:test";
import { isTcpPortOpen, waitForPortClosure } from "../scripts/opencode-e2e/runtime-process";
import {
  acquireLoopbackGuard,
  closeLoopbackGuard,
  requireFallbackOpenCodeListener,
  requireOwnedTcpListener,
} from "../scripts/opencode-e2e/loopback-guard";

const DARWIN_ARM64 = process.platform === "darwin" && process.arch === "arm64";

describe("harness-owned OpenCode fallback guard", () => {
  test.skipIf(!DARWIN_ARM64)("holds 4096 under the exact harness PID and exposes its listener FD", async () => {
    // Given the harness has acquired the fixed loopback guard before an OpenCode spawn.
    const guard = acquireLoopbackGuard();
    try {
      // When exact-PID lsof ownership is captured for its listener.
      const ownership = requireOwnedTcpListener(guard.pid, guard.port);

      // Then the guard is the sole exact-PID listener receipt and remains reachable until owned cleanup.
      expect(guard).toMatchObject({ pid: process.pid, port: 4096 });
      expect(ownership).toMatchObject({ pid: process.pid, port: 4096, address: "127.0.0.1:4096" });
      expect(ownership.fd).toMatch(/^[1-9][0-9]*[a-z]?$/u);
      expect(await isTcpPortOpen(4096)).toBe(true);
    } finally {
      await closeLoopbackGuard(guard);
    }
    expect(await waitForPortClosure(4096, 1_000)).toBe(true);
  });

  test("fails closed without probing, closing, or terminating an occupied 4096 listener", async () => {
    // Given an existing listener that the prospective guard does not own.
    const existing = Bun.serve({ hostname: "127.0.0.1", port: 4096, fetch: () => new Response("existing") });
    try {
      // When guard acquisition attempts the required bind.
      const acquire = () => acquireLoopbackGuard();

      // Then acquisition fails and the pre-existing listener remains live and responsive.
      expect(acquire).toThrow("socket");
      expect(await isTcpPortOpen(4096)).toBe(true);
      expect(await (await fetch("http://127.0.0.1:4096", { signal: AbortSignal.timeout(500) })).text()).toBe("existing");
    } finally {
      await existing.stop(true);
    }
    expect(await waitForPortClosure(4096, 1_000)).toBe(true);
  });

  test.skipIf(!DARWIN_ARM64)("accepts only an exact-PID non-4096 listener while the guard remains owned", async () => {
    // Given the fixed guard and a distinct harness-owned OS-assigned loopback listener.
    const guard = acquireLoopbackGuard();
    const fallback = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("fallback") });
    const port = fallback.port;
    if (port === undefined) throw new Error("missing fallback port");
    try {
      // When OpenCode fallback ownership is checked against the live guard.
      const receipt = requireFallbackOpenCodeListener(guard, process.pid, port);

      // Then the distinct listener is accepted and 4096 can never masquerade as fallback.
      expect(receipt).toMatchObject({ pid: process.pid, port, address: `127.0.0.1:${String(port)}` });
      expect(() => requireFallbackOpenCodeListener(guard, process.pid, 4096)).toThrow("socket");
    } finally {
      await fallback.stop(true);
      await closeLoopbackGuard(guard);
    }
  }, 20_000);
});
