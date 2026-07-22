import { describe, expect, test } from "bun:test";
import { analyzeShell } from "../src/shell-analysis";
import { createCommandEffect } from "../src/command-effect";

describe("CommandEffect", () => {
  test("stable-serializes the exact execution effect independently of key insertion order", async () => {
    // Given one canonical command effect with JSON-safe arguments in different insertion orders.
    const analysis = await analyzeShell("curl https://example.test/upload", "/workspace");
    const left = { command: "curl https://example.test/upload", cwd: "/workspace", sessionID: "parent", tool: "bash", args: { z: 1, a: [true] } };
    const right = { ...left, args: { a: [true], z: 1 } };

    // When both effects are projected and hashed.
    const results = [left, right].map((context) => createCommandEffect({ context, analysis }));
    const first = results[0];
    if (!first) throw new Error("missing projected effect");

    // Then their canonical DTO, serialization, and SHA-256 identity are equal.
    expect(results[0]).toEqual(results[1]);
    expect(first.ok && first.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.ok && first.serialized).not.toContain("transcript");
  });

  test("rejects non-JSON arguments and changes identity for every bound effect field", async () => {
    // Given a base effect, a cyclic argument, and variants of every boundary field.
    const analysis = await analyzeShell("echo safe", "/workspace");
    const base = {
      command: "echo safe",
      cwd: "/workspace",
      sessionID: "parent",
      tool: "bash",
      args: { command: "echo safe", description: "Print text", timeout: 1_000, workdir: "/workspace" },
    };
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const variants = [
      { ...base, sessionID: "other" },
      { ...base, cwd: "/other" },
      { ...base, tool: "shell" },
      { ...base, command: "echo other" },
      { ...base, args: { ...base.args, timeout: 2_000 } },
    ];

    // When the invalid and distinct effects are projected.
    const invalid = createCommandEffect({ context: { ...base, args: cyclic }, analysis });
    const original = createCommandEffect({ context: base, analysis });
    const hashes = variants.map((context) => createCommandEffect({ context, analysis }));

    // Then invalid JSON fails closed and every changed effect has a distinct hash.
    expect(invalid).toEqual({ ok: false, code: "invalid_effect" });
    expect(original.ok).toBe(true);
    expect(hashes.every((result) => result.ok && original.ok && result.sha256 !== original.sha256)).toBe(true);
  });
});
