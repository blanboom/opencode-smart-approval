import { describe, expect, test } from "bun:test";
import type { RuleCategory } from "../src/types";
import {
  renderCommandApprovalError,
  renderConfirmationBody,
} from "../src/user-facing";
import { challenge, verdict } from "./fixtures/user-facing-error-fixture";

describe("CommandApprovalError rendering", () => {
  test("escapes every untrusted reason source without emitting terminal controls", () => {
    // Given adversarial reason text for every fixed source code.
    const sources = ["rule", "tirith", "path", "policy", "provider", "parser", "reviewer", "lifecycle"] as const;
    const payload = "raw\r\n\t\u0000\u0007\u001B]52;c;YQ==\u0007\u202E`\\\"";

    // When every source is rendered into an approval error.
    const results = sources.map((source) => renderCommandApprovalError({
      kind: "ordinary",
      tool: "bash\u001B]0;title\u0007",
      verdict: verdict(source, [payload]),
    }));

    // Then output is inert, fixed-source plain text and raw labels are discarded.
    for (const result of results) {
      expect(result.kind).toBe("error");
      if (result.kind !== "error") continue;
      expect(result.error.message).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200E-\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/u);
      expect(result.error.message).not.toContain("raw-label-must-not-escape");
      expect(result.error.verdict.matchedRuleLabels).toEqual([]);
      expect(result.error.verdict.reasons[0]).toContain("\\u001B]52");
    }
  });

  test("caps ordinary reasons, categories, aggregate bytes, and appends one fixed marker", () => {
    // Given 33 valid categories plus invalid injected categories and reasons beyond all tail caps.
    const categories: readonly RuleCategory[] = [
      ...Array.from({ length: 33 }, (_, index) => ({ id: `security.category_${String(index)}`, score: 0.5 })),
      { id: "bad\ncategory", score: 0.5 },
      { id: "bad-score", score: Number.POSITIVE_INFINITY },
    ];
    const reasons = [
      ...Array.from({ length: 7 }, () => "x".repeat(1_015)),
      "x".repeat(1_010),
      "",
      ...Array.from({ length: 8 }, () => "tail"),
    ];

    // When the ordinary branch renders the oversized structured verdict.
    const result = renderCommandApprovalError({ kind: "ordinary", tool: "bash", verdict: verdict("provider", reasons, categories) });

    // Then only complete validated entries fit and exactly one marker records tail loss.
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    const lines = result.error.message.split("\n");
    expect(lines.filter((line) => line.startsWith("category="))).toHaveLength(32);
    expect(lines.filter((line) => line.startsWith("reason="))).toHaveLength(8);
    expect(lines.filter((line) => line === "truncated=true")).toHaveLength(1);
    expect(Buffer.byteLength(result.error.message)).toBeLessThanOrEqual(16_384);
    expect(result.error.verdict.categories).toHaveLength(32);
    expect(result.error.verdict.reasons).toHaveLength(8);
  });

  test("preserves the 8192-byte aggregate reason limit exactly", () => {
    // Given eight rendered reasons whose combined size is exactly 8192 bytes.
    const reasons = Array.from({ length: 8 }, () => "x".repeat(1_015));

    // When the ordinary branch renders the exact-limit verdict.
    const result = renderCommandApprovalError({ kind: "ordinary", tool: "bash", verdict: verdict("provider", reasons) });

    // Then all eight reasons remain and no truncation marker is needed.
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.error.verdict.reasons).toHaveLength(8);
    expect(result.error.verdict.reasons.reduce((total, reason) => total + Buffer.byteLength(reason), 0)).toBe(8_192);
    expect(result.error.message).not.toContain("truncated=true");
  });

  test("drops only the seventeenth ordinary reason", () => {
    // Given ordinary verdicts with 15, 16, and 17 short reasons.
    const counts = [15, 16, 17];
    const inputs = counts.map((count) => verdict("rule", Array.from({ length: count }, (_, index) => `reason-${String(index)}`)));

    // When the count-boundary matrix is rendered.
    const results = inputs.map((input) => renderCommandApprovalError({ kind: "ordinary", tool: "bash", verdict: input }));

    // Then the first 16 complete reasons survive and only limit+1 records truncation.
    expect(results.map((result) => result.kind === "error" ? result.error.verdict.reasons.length : -1)).toEqual([15, 16, 16]);
    expect(results.map((result) => result.kind === "error" && result.error.message.includes("truncated=true"))).toEqual([false, false, true]);
  });

  test("retains at most 32 validated categories at the exact count boundary", () => {
    // Given ordinary verdicts with 31, 32, and 33 valid categories.
    const counts = [31, 32, 33];
    const inputs = counts.map((count) => verdict("rule", ["reason"], Array.from(
      { length: count },
      (_, index) => ({ id: `security.category_${String(index)}`, score: 0.5 }),
    )));

    // When the category-count matrix is rendered.
    const results = inputs.map((input) => renderCommandApprovalError({ kind: "ordinary", tool: "bash", verdict: input }));

    // Then limit-1 and limit are complete while limit+1 drops only its tail category.
    expect(results.map((result) => result.kind === "error" ? result.error.verdict.categories.length : -1)).toEqual([31, 32, 32]);
    expect(results.map((result) => result.kind === "error" && result.error.message.includes("truncated=true"))).toEqual([false, false, true]);
  });

  test("enforces aggregate reason bytes at limit-1, limit, and limit+1", () => {
    // Given reason sets totaling exactly 8191, 8192, and 8193 rendered bytes.
    const sevenMaximums = Array.from({ length: 7 }, () => "x".repeat(1_018));
    const inputs = [
      [...sevenMaximums, "x".repeat(1_017)],
      [...sevenMaximums, "x".repeat(1_018)],
      [...sevenMaximums, "x".repeat(1_013), ""],
    ];

    // When the aggregate-boundary matrix is rendered.
    const results = inputs.map((reasons) => renderCommandApprovalError({
      kind: "ordinary",
      tool: "bash",
      verdict: verdict("rule", reasons),
    }));

    // Then the exact limit is accepted and only the complete limit+1 tail reason is dropped.
    expect(results.map((result) => result.kind === "error"
      ? result.error.verdict.reasons.reduce((total, reason) => total + Buffer.byteLength(reason), 0)
      : -1)).toEqual([8_191, 8_192, 8_187]);
    expect(results.map((result) => result.kind === "error" && result.error.message.includes("truncated=true"))).toEqual([false, false, true]);
  });

  test("emits all six confirmation values in fixed order without ordinary truncation", () => {
    // Given six distinct complete values containing escapable delimiters and controls.
    const values = {
      command: "command\nvalue",
      cwd: "cwd\\value",
      action: "action\"value",
      data: "data`value",
      destination: "destination\u202Evalue",
      risk: "risk😀value",
    };

    // When the confirmation scaffold renders them.
    const result = renderConfirmationBody(challenge(values));

    // Then every complete escaped value appears once in the exact contract order.
    expect(result).toEqual({
      ok: true,
      body: [
        "[CommandApproval]",
        "decision=block",
        "category=security.explicit_confirmation_required;score=1",
        "command=\"command\\u000Avalue\"",
        "cwd=\"cwd\\\\value\"",
        "action=\"action\\\"value\"",
        "data=\"data\\u0060value\"",
        "destination=\"destination\\u202Evalue\"",
        "risk=\"risk😀value\"",
        `effect_sha256=${"a".repeat(64)}`,
        `disclosure_sha256=${"b".repeat(64)}`,
        "scope=parent-session+canonical-cwd+command-effect;expires_in=300s",
        "prior_challenge_replaced=false",
        `authorization_phrase=AUTHORIZE opencode-smart-approval ${"C".repeat(43)}`,
      ].join("\n"),
    });
  });

  test("accepts confirmation bodies at 16384 bytes and rejects the next byte", () => {
    // Given confirmation values at limit-1, limit, and limit+1 complete body sizes.
    const base = { command: "command", cwd: "", action: "", data: "", destination: "", risk: "" };
    const baseResult = renderConfirmationBody(challenge(base));
    if (!baseResult.ok) throw new Error("missing confirmation scaffold");
    const fill = 16_384 - Buffer.byteLength(baseResult.body);
    const below = { ...base, risk: "x".repeat(fill - 1) };
    const exact = { ...base, risk: "x".repeat(fill) };
    const above = { ...base, risk: "x".repeat(fill + 1) };

    // When the complete bodies are rendered without truncation.
    const belowResult = renderConfirmationBody(challenge(below));
    const exactResult = renderConfirmationBody(challenge(exact));
    const aboveResult = renderConfirmationBody(challenge(above));
    const aboveError = renderCommandApprovalError({
      kind: "confirmation",
      tool: "bash",
      verdict: verdict("lifecycle", ["confirmation required"]),
      challenge: challenge(above),
    });

    // Then limit-1 and limit are complete while limit+1 is a fixed failure.
    expect(belowResult.ok && Buffer.byteLength(belowResult.body)).toBe(16_383);
    expect(exactResult.ok && Buffer.byteLength(exactResult.body)).toBe(16_384);
    expect(aboveResult).toEqual({ ok: false, code: "confirmation_render_failed" });
    expect(aboveError).toEqual({ kind: "confirmation_failure", code: "confirmation_render_failed" });
  });

  test.each([
    ["command", 0xd800], ["command", 0xdc00],
    ["cwd", 0xd800], ["cwd", 0xdc00],
    ["action", 0xd800], ["action", 0xdc00],
    ["data", 0xd800], ["data", 0xdc00],
    ["destination", 0xd800], ["destination", 0xdc00],
    ["risk", 0xd800], ["risk", 0xdc00],
  ] as const)(
    "rejects invalid confirmation Unicode in %s before an error or token state exists",
    (field, surrogate) => {
    // Given each lone surrogate direction in every mandatory disclosure field in turn.
    const valid = {
      command: "command",
      cwd: "cwd",
      action: "action",
      data: "data",
      destination: "destination",
      risk: "risk",
    };
    const invalid = { ...valid, [field]: String.fromCharCode(surrogate) };

    // When the confirmation error branch is requested.
    const result = renderCommandApprovalError({
      kind: "confirmation",
      tool: "bash",
      verdict: verdict("lifecycle", ["confirmation required"]),
      challenge: challenge(invalid),
    });

    // Then only the fixed machine failure exists and no error or token-bearing state is created.
    expect(result).toEqual({ kind: "confirmation_failure", code: "confirmation_render_failed" });
    expect(Object.keys(result).sort()).toEqual(["code", "kind"]);
  });

  test("enforces the escaped command cap independently of the complete body cap", () => {
    // Given escaped command values at 8192 and 8193 UTF-8 bytes with a small remaining disclosure.
    const base = { cwd: "cwd", action: "action", data: "data", destination: "destination", risk: "risk" };

    // When both command boundary values are rendered.
    const exact = renderConfirmationBody(challenge({ command: "x".repeat(8_192), ...base }));
    const above = renderConfirmationBody(challenge({ command: "x".repeat(8_193), ...base }));

    // Then the exact command cap is accepted and its next byte fails closed.
    expect(exact.ok).toBe(true);
    expect(above).toEqual({ ok: false, code: "confirmation_render_failed" });
  });

});
