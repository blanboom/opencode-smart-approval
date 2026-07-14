import { describe, expect, test } from "bun:test";
import { defaultRules } from "../src/default-rules";
import { evaluateRules } from "../src/rules";

const appleSpecificTerms = /apple|apfs|diskutil|hdiutil|launchctl|security|sw_vers|time machine|tmutil|xcode|xcrun/iu;

describe("builtin approval rules", () => {
  test("stay intentionally small and contain only allow or deny decisions", () => {
    // Given the complete builtin rule set.
    const rules = defaultRules();

    // When its policy surface is inspected.
    const denyCount = rules.filter((rule) => rule.decision === "block").length;

    // Then it remains a narrow deterministic fast path instead of a risk catalog.
    expect(rules.length).toBeLessThanOrEqual(5);
    expect(rules.every((rule) => rule.decision === "allow" || rule.decision === "block")).toBe(true);
    expect(denyCount).toBeLessThanOrEqual(1);
  });

  test("does not encode Apple-specific command policy", () => {
    // Given builtin rule patterns and explanations.
    const policyText = defaultRules().map((rule) => `${rule.match}\n${rule.reason ?? ""}`).join("\n");

    // When platform-specific vocabulary is searched.
    const match = policyText.match(appleSpecificTerms);

    // Then no Apple-only exception remains in the generic builtin layer.
    expect(match).toBeNull();
  });

  test("allows a compact set of common low-risk commands including pipelines", async () => {
    // Given representative shell glue and basic inspection commands.
    const commands = ["echo ok", "pwd", "command -v bun", "echo ok | printf done"];

    // When only builtin rules are evaluated.
    const evaluations = await Promise.all(commands.map((command) => evaluateRules(defaultRules(), { command })));

    // Then every static segment is covered and the command can short-circuit safely.
    expect(evaluations.map((evaluation) => evaluation.decision)).toEqual(commands.map(() => "allow"));
    expect(evaluations.every((evaluation) => evaluation.matchedRules.length > 0)).toBe(true);
  });

  test("leaves risky commands unmatched for the scanner and LLM stages", async () => {
    // Given commands with remote, publication, or destructive effects.
    const commands = ["git push origin main", "npm publish", "rm -rf build", "echo ok > output.txt"];

    // When only builtin rules are evaluated.
    const evaluations = await Promise.all(commands.map((command) => evaluateRules(defaultRules(), { command })));

    // Then builtins neither allow nor deny them and later stages own the decision.
    expect(evaluations.map((evaluation) => evaluation.decision)).toEqual(commands.map(() => "review"));
    expect(evaluations.every((evaluation) => evaluation.matchedRules.length === 0)).toBe(true);
  });
});
