import { describe, expect, test } from "bun:test";
import { policyFromUnknown } from "../src/policy-parser";

const minimalPolicy = { version: 3, review: {} } as const;

const expectPolicyFailure = (value: unknown, field: string): void => {
  expect(() => policyFromUnknown(value, [])).toThrow(field);
};

describe("policy v3 document structure", () => {
  test.each([
    ["unversioned", { review: {} }, "version"],
    ["version 1", { version: 1, review: {} }, "version"],
    ["version 2", { version: 2, review: {} }, "version"],
    ["string version", { version: "3", review: {} }, "version"],
    ["missing review", { version: 3 }, "review"],
    ["null review", { version: 3, review: null }, "review"],
  ])("rejects %s policy documents", (_label, policy, field) => {
    // Given an obsolete or incomplete public document.
    // When/Then the atomic v3 boundary rejects it.
    expectPolicyFailure(policy, field);
  });

  test.each([
    ["top-level", { ...minimalPolicy, surprise: true }, "surprise"],
    ["review", { ...minimalPolicy, review: { surprise: true } }, "review.surprise"],
    ["self protection", { ...minimalPolicy, self_protection: { enabled: true, surprise: true } }, "self_protection.surprise"],
    ["Tirith", { ...minimalPolicy, tirith: { enabled: true, surprise: true } }, "tirith.surprise"],
    ["rules collection", { ...minimalPolicy, rules: { deny: [], surprise: [] } }, "rules.surprise"],
    ["rule", { ...minimalPolicy, rules: { deny: [{ match: "^x$", surprise: true }] } }, "rules.deny.0.surprise"],
  ])("rejects an unknown field in the %s object", (_label, policy, field) => {
    // Given an unknown field at a strict v3 object boundary.
    // When/Then configuration loading fails closed.
    expectPolicyFailure(policy, field);
  });

  test("accepts strict deny, review, and allow rule objects", () => {
    // Given every supported rule list and field.
    const policy = {
      ...minimalPolicy,
      rules: {
        deny: [{ match: "^deny$", reason: "deny reason", scope: "command", priority: 3 }],
        review: [{ match: "^review$", scope: "segment", priority: -2 }],
        allow: [{ match: "^allow$" }],
      },
    };

    // When the rules are compiled.
    const rules = policyFromUnknown(policy, []).rules;

    // Then all decisions retain their strict order and shape.
    expect(rules.map((rule) => [rule.decision, rule.match, rule.reason])).toEqual([
      ["block", "^deny$", "deny reason"],
      ["review", "^review$", undefined],
      ["allow", "^allow$", undefined],
    ]);
  });

  test.each([
    ["deny shorthand", { deny: ["^deny$"] }, "rules.deny.0"],
    ["review shorthand", { review: ["^review$"] }, "rules.review.0"],
    ["allow shorthand", { allow: ["^allow$"] }, "rules.allow.0"],
    ["unsafe priority", { deny: [{ match: "^x$", priority: Number.MAX_SAFE_INTEGER + 1 }] }, "rules.deny.0.priority"],
    ["fractional priority", { deny: [{ match: "^x$", priority: 1.5 }] }, "rules.deny.0.priority"],
    ["empty match", { deny: [{ match: "" }] }, "rules.deny.0.match"],
    ["bad scope", { deny: [{ match: "^x$", scope: "pipeline" }] }, "rules.deny.0.scope"],
  ])("rejects %s", (_label, rules, field) => {
    // Given a non-v3 rule representation.
    // When/Then no shorthand or invalid rule is compiled.
    expectPolicyFailure({ ...minimalPolicy, rules }, field);
  });

  test("preserves strict local opt-in, self-protection, and Tirith settings", () => {
    // Given all preserved non-review v3 settings.
    const policy = policyFromUnknown({
      ...minimalPolicy,
      allow_local_config: true,
      self_protection: { enabled: false },
      tirith: { enabled: false, path: "/opt/tirith", timeout_ms: 500, fail_open: true },
    }, []);

    // When/Then the runtime policy retains their exact validated values.
    expect(policy.selfProtection).toEqual({ enabled: false });
    expect(policy.tirith).toEqual({ enabled: false, path: "/opt/tirith", timeoutMs: 500, failOpen: true });
  });

  test.each([
    ["local opt-in type", { ...minimalPolicy, allow_local_config: "yes" }, "allow_local_config"],
    ["self-protection type", { ...minimalPolicy, self_protection: { enabled: "yes" } }, "self_protection.enabled"],
    ["Tirith enabled type", { ...minimalPolicy, tirith: { enabled: "yes" } }, "tirith.enabled"],
    ["Tirith path empty", { ...minimalPolicy, tirith: { path: "" } }, "tirith.path"],
    ["Tirith relative path", { ...minimalPolicy, tirith: { path: "./tirith" } }, "tirith.path"],
    ["Tirith timeout below", { ...minimalPolicy, tirith: { timeout_ms: 499 } }, "tirith.timeout_ms"],
    ["Tirith timeout above", { ...minimalPolicy, tirith: { timeout_ms: 60_001 } }, "tirith.timeout_ms"],
    ["Tirith timeout fractional", { ...minimalPolicy, tirith: { timeout_ms: 500.5 } }, "tirith.timeout_ms"],
    ["Tirith fail-open type", { ...minimalPolicy, tirith: { fail_open: "yes" } }, "tirith.fail_open"],
  ])("rejects invalid %s", (_label, policy, field) => {
    // Given an invalid preserved v3 setting.
    // When/Then it fails at the strict boundary.
    expectPolicyFailure(policy, field);
  });
});
