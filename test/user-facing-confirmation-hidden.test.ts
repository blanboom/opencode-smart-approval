import { describe, expect, test } from "bun:test";
import { renderConfirmationBody } from "../src/user-facing";
import { challenge } from "./fixtures/user-facing-error-fixture";

describe("hidden Unicode confirmation rendering", () => {
  test("escapes hidden scalars while preserving supplied hash fields", () => {
    const hidden = "\u{E0100}\u200D";
    const values = {
      command: `command${hidden}`,
      cwd: `cwd${hidden}`,
      action: `action${hidden}`,
      data: `data${hidden}`,
      destination: `destination${hidden}`,
      risk: `risk${hidden}`,
    };
    const result = renderConfirmationBody(challenge(values));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const [label, value] of Object.entries(values)) {
      expect(result.body).toContain(`${label}="${label}\\u{E0100}\\u200D"`);
      expect(result.body).not.toContain(value);
    }
    expect(result.body).toContain(`effect_sha256=${"a".repeat(64)}`);
    expect(result.body).toContain(`disclosure_sha256=${"b".repeat(64)}`);
  });

  test("counts supplementary escapes against the command byte cap", () => {
    const hidden = "\u{E0100}";
    const base = { cwd: "cwd", action: "action", data: "data", destination: "destination", risk: "risk" };
    const exact = renderConfirmationBody(challenge({ command: `${"x".repeat(8_183)}${hidden}`, ...base }));
    const above = renderConfirmationBody(challenge({ command: `${"x".repeat(8_183)}${hidden}x`, ...base }));
    expect(exact.ok).toBe(true);
    expect(above).toEqual({ ok: false, code: "confirmation_render_failed" });
  });
});
