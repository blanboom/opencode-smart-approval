import { describe, expect, test } from "bun:test";
import {
  escapeUserFacingScalar,
  renderUserFacingReason,
} from "../src/user-facing";

describe("user-facing approval rendering", () => {
  test("escapes terminal controls and delimiter-like scalars without changing ordinary Unicode", () => {
    // Given untrusted text containing terminal controls and renderer delimiters.
    const value = "safe\\\"`\u0000\u001B\u007F\u009F\u061C\u200E\u202E\u2066\u2069\uFEFF雪😀";

    // When the scalar gateway renders it.
    const escaped = escapeUserFacingScalar(value);

    // Then every dangerous scalar is inert and ordinary Unicode is preserved.
    expect(escaped).toEqual({
      ok: true,
      value: "safe\\\\\\\"\\u0060\\u0000\\u001B\\u007F\\u009F\\u061C\\u200E\\u202E\\u2066\\u2069\\uFEFF雪😀",
    });
  });

  test("rejects an unpaired UTF-16 surrogate before user-facing rendering", () => {
    // Given a string that is not a Unicode scalar sequence.
    const invalid = `prefix${String.fromCharCode(0xd800)}suffix`;

    // When the scalar gateway and reason gateway render it.
    const escaped = escapeUserFacingScalar(invalid);
    const reason = renderUserFacingReason({ source: "tirith", text: invalid });

    // Then raw invalid text is never emitted.
    expect(escaped).toEqual({ ok: false, code: "invalid_unicode" });
    expect(reason).toBe("tirith: [invalid-unicode]");
  });

  test("escapes every required control and bidi code point with uppercase four-digit notation", () => {
    // Given every scalar in the control ranges plus every bidi and BOM scalar.
    const codePoints = [
      ...Array.from({ length: 0x20 }, (_, index) => index),
      ...Array.from({ length: 0x21 }, (_, index) => 0x7f + index),
      0x061c,
      0x200e,
      0x200f,
      ...Array.from({ length: 7 }, (_, index) => 0x2028 + index),
      ...Array.from({ length: 4 }, (_, index) => 0x2066 + index),
      0xfeff,
    ];
    const value = String.fromCodePoint(...codePoints);
    const expected = codePoints
      .map((codePoint) => `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`)
      .join("");

    // When the complete matrix passes through the scalar gateway.
    const escaped = escapeUserFacingScalar(value);

    // Then every scalar is represented by one exact inert escape.
    expect(escaped).toEqual({ ok: true, value: expected });
  });

  test("escapes default-ignorable scalars at every concealment range boundary", () => {
    // Given the first and last scalar of each ECMAScript Default_Ignorable_Code_Point range.
    const codePoints = [
      0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5,
      0x180b, 0x180f, 0x200b, 0x200d, 0x200f, 0x202a, 0x202e,
      0x2060, 0x206f, 0x3164, 0xfe00, 0xfe0f, 0xfeff, 0xffa0,
      0xfff0, 0xfff8, 0x1bca0, 0x1bca3, 0x1d173, 0x1d17a,
      0xe0000, 0xe0fff,
    ];
    const value = String.fromCodePoint(...codePoints);

    // When the complete scalar sequence passes through the user-facing gateway.
    const escaped = escapeUserFacingScalar(value);

    // Then every hidden scalar is represented explicitly, including supplementary ranges.
    expect(escaped).toEqual({
      ok: true,
      value: codePoints.map((codePoint) => codePoint <= 0xffff
        ? `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`
        : `\\u{${codePoint.toString(16).toUpperCase()}}`).join(""),
    });
  });

  test("reserves escaped supplementary scalars atomically at the reason byte boundary", () => {
    // Given a supplementary variation selector that exactly fills the reserved content budget.
    const hidden = "\u{E0100}";
    const value = `${"x".repeat(995)}${hidden}${"tail".repeat(6)}`;

    // When the reason renderer truncates after the hidden scalar.
    const rendered = renderUserFacingReason({ source: "rule", text: value });

    // Then the explicit escape is complete and the fixed suffix keeps the whole reason bounded.
    expect(rendered).toBe(`rule: ${"x".repeat(995)}\\u{E0100}...[truncated]`);
    expect(Buffer.byteLength(rendered)).toBe(1_024);
    expect(rendered).not.toContain(hidden);
  });

  test("keeps reason output at or below the exact 1024-byte boundary", () => {
    // Given one reason at the byte limit and one immediately below it.
    const atLimit = "x".repeat(1_018);
    const belowLimit = "x".repeat(1_017);

    // When both are rendered with the fixed source prefix.
    const atLimitRendered = renderUserFacingReason({ source: "rule", text: atLimit });
    const belowLimitRendered = renderUserFacingReason({ source: "rule", text: belowLimit });

    // Then neither is truncated and their exact UTF-8 sizes are preserved.
    expect(Buffer.byteLength(atLimitRendered)).toBe(1_024);
    expect(Buffer.byteLength(belowLimitRendered)).toBe(1_023);
    expect(atLimitRendered.endsWith("...[truncated]")).toBe(false);
    expect(belowLimitRendered.endsWith("...[truncated]")).toBe(false);
  });

  test("truncates only at a complete escaped-scalar boundary above 1024 bytes", () => {
    // Given text whose next astral scalar cannot fit before the reserved suffix.
    const value = `${"x".repeat(1_003)}😀tailtailtailtail`;

    // When the reason exceeds the byte limit.
    const rendered = renderUserFacingReason({ source: "rule", text: value });

    // Then the astral scalar is not split and the exact suffix fills the byte budget.
    expect(rendered).toBe(`rule: ${"x".repeat(1_003)}...[truncated]`);
    expect(Buffer.byteLength(rendered)).toBe(1_023);
    expect(rendered).not.toContain("😀");
  });

  test("uses the reserved suffix at the exact 1025-byte reason boundary", () => {
    // Given one ASCII reason exactly one byte above the fixed limit.
    const value = "x".repeat(1_019);

    // When the reason gateway renders it.
    const rendered = renderUserFacingReason({ source: "rule", text: value });

    // Then the complete fixed suffix is reserved within exactly 1024 bytes.
    expect(Buffer.byteLength(rendered)).toBe(1_024);
    expect(rendered).toBe(`rule: ${"x".repeat(1_004)}...[truncated]`);
  });

  test("bounds large output while still detecting invalid Unicode after the truncation point", () => {
    // Given large valid text and a second large value ending in an invalid surrogate.
    const large = "x".repeat(1_000_000);
    const invalidTail = `${"x".repeat(50_000)}${String.fromCharCode(0xd800)}`;

    // When both values pass through the bounded reason renderer.
    const rendered = renderUserFacingReason({ source: "rule", text: large });
    const rejected = renderUserFacingReason({ source: "rule", text: invalidTail });

    // Then output stays bounded and invalid input never becomes a truncated partial disclosure.
    expect(Buffer.byteLength(rendered)).toBe(1_024);
    expect(rendered.endsWith("...[truncated]")).toBe(true);
    expect(rejected).toBe("rule: [invalid-unicode]");
  });
});
