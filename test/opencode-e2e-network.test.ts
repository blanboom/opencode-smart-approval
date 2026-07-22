import { describe, expect, test } from "bun:test";
import { parseLsofSockets, requireLoopbackSockets } from "../scripts/opencode-e2e/network";

describe("owned-process socket receipts", () => {
  test("parses loopback TCP listeners and connections for the exact PID", () => {
    // Given classic lsof output for one listener and one connected socket.
    const output = [
      "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
      "opencode 420 me 10u IPv4 0x1 0t0 TCP 127.0.0.1:43124 (LISTEN)",
      "opencode 420 me 11u IPv4 0x2 0t0 TCP 127.0.0.1:53124->127.0.0.1:43123 (ESTABLISHED)",
    ].join("\n");

    // When the lsof boundary parses the exact owned PID.
    const sockets = parseLsofSockets(output, 420);

    // Then both protocol/name receipts are retained and pass loopback enforcement.
    expect(sockets).toEqual([
      { pid: 420, protocol: "TCP", name: "127.0.0.1:43124 (LISTEN)" },
      { pid: 420, protocol: "TCP", name: "127.0.0.1:53124->127.0.0.1:43123 (ESTABLISHED)" },
    ]);
    expect(() => requireLoopbackSockets(sockets)).not.toThrow();
  });

  test("rejects wildcard, non-loopback, malformed, and foreign-PID receipts", () => {
    // Given socket outputs that cannot support the attributable loopback claim.
    const wildcard = [{ pid: 420, protocol: "TCP" as const, name: "*:43124 (LISTEN)" }];
    const external = [{ pid: 420, protocol: "TCP" as const, name: "127.0.0.1:53124->203.0.113.9:443 (ESTABLISHED)" }];
    const malformedCall = () => parseLsofSockets("opencode nope me 10u IPv4 x 0t0 TCP ???", 420);
    const foreignCall = () => parseLsofSockets("opencode 421 me 10u IPv4 x 0t0 TCP 127.0.0.1:43124 (LISTEN)", 420);

    // When each receipt is validated.
    // Then the boundary fails closed without accepting an unowned or external socket.
    expect(() => requireLoopbackSockets(wildcard)).toThrow("socket");
    expect(() => requireLoopbackSockets(external)).toThrow("socket");
    expect(malformedCall).toThrow("socket");
    expect(foreignCall).toThrow("socket");
  });
});
