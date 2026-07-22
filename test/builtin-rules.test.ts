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

  test("allows a compact set of constrained non-output commands including pipelines", async () => {
    // Given representative shell predicates and basic inspection commands.
    const commands = ["true", "false", "test -n value", "pwd", "command -v bun", "true | false"];

    // When only builtin rules are evaluated.
    const evaluations = await Promise.all(commands.map((command) => evaluateRules(defaultRules(), { command })));

    // Then every constrained static segment is covered and the command can short-circuit safely.
    expect(evaluations.map((evaluation) => evaluation.decision)).toEqual(commands.map(() => "allow"));
    expect(evaluations.every((evaluation) => evaluation.matchedRules.length > 0)).toBe(true);
  });

  test.each([
    ["plain echo", "echo harmless"],
    ["echo -e OSC 52 with BEL", String.raw`echo -e '\033]52;c;Y2xpcGJvYXJk\a'`],
    ["printf plain format", "printf '%s' harmless"],
    [
      "printf percent-b OSC 8 with string terminators",
      String.raw`printf '%b' '\033]8;;https://example.invalid\033\\label\033]8;;\033\\'`,
    ],
    ["raw escape and BEL", `printf '\u001B]52;c;Y2xpcGJvYXJk\u0007'`],
    ["echo command substitution", 'echo "$(id)"'],
    ["printf parameter substitution", "printf '%s' \"$HOME\""],
    ["malformed echo quote", "echo '"],
    ["malformed printf escape", String.raw`printf '%b' '\x'`],
    ["malformed command substitution", 'echo "$('],
    ["echo executable path", "/bin/echo harmless"],
    ["printf executable path", "/usr/bin/printf '%s' harmless"],
    ["command wrapper", "command echo harmless"],
    ["builtin wrapper", "builtin printf '%s' harmless"],
    ["environment wrapper", "env /usr/bin/printf '%s' harmless"],
    ["applet wrapper", "busybox echo harmless"],
  ])("routes output-capable command beyond builtin allow: %s", async (_name, command) => {
    // Given an output-capable invocation represented only as shell source text.

    // When builtin rules evaluate it without executing the command.
    const evaluation = await evaluateRules(defaultRules(), { command });

    // Then Tirith and the reviewer remain responsible for every output form.
    expect(evaluation.decision).toBe("review");
    expect(evaluation.matchedRules).toEqual([]);
  });

  test("leaves risky commands unmatched for the scanner and OpenCode reviewer stages", async () => {
    // Given commands with remote, publication, or destructive effects.
    const commands = ["git push origin main", "npm publish", "rm -rf build", "echo ok > output.txt"];

    // When only builtin rules are evaluated.
    const evaluations = await Promise.all(commands.map((command) => evaluateRules(defaultRules(), { command })));

    // Then builtins neither allow nor deny them and later stages own the decision.
    expect(evaluations.map((evaluation) => evaluation.decision)).toEqual(commands.map(() => "review"));
    expect(evaluations.every((evaluation) => evaluation.matchedRules.length === 0)).toBe(true);
  });

  test("does not terminal-allow executable modifiers or wrapper dispatch", async () => {
    // Given commands whose visible effective executable is ls but whose execution identity is modified.
    const commands = [
      "PATH=./untrusted ls",
      "env PATH=./untrusted ls",
      "LD_PRELOAD=./evil.so /bin/ls",
      "DYLD_INSERT_LIBRARIES=./evil.dylib /bin/ls",
      "command ls",
      "exec ls",
      "env ls",
      "nice ls",
      "nice -n 5 ls",
      "nohup ls",
      "time -o /tmp/time.log ls",
      "builtin ls",
      "busybox ls",
      "sudo ls",
    ];

    // When builtin rules evaluate the authoritative shell analysis.
    const evaluations = await Promise.all(commands.map((command) => evaluateRules(defaultRules(), { command })));

    // Then every modified invocation continues to Tirith and review.
    expect(evaluations.map((evaluation) => evaluation.decision)).toEqual(commands.map(() => "review"));
    expect(evaluations.every((evaluation) => evaluation.matchedRules.length === 0)).toBe(true);
    expect((await evaluateRules(defaultRules(), { command: "ls" })).decision).toBe("allow");
    expect((await evaluateRules(defaultRules(), { command: "/bin/ls -la" })).decision).toBe("allow");
  });

});
