import { describe, expect, test } from "bun:test";
import { defaultPolicy } from "../src/default-config";
import { policyFromUnknown } from "../src/policy-parser";
import { evaluateRules } from "../src/rules";
import { analyzeShell } from "../src/shell-analysis";
import type { RuleEvaluation } from "../src/types";
import { expectStructurallyAllowedOrHostUnavailable } from "./host-aware-policy-expectation";
import { evaluate } from "./mandatory-guards-helpers";

describe("host-aware policy expectation", () => {
  test("accepts an unavailable executable only when every segment is structurally allowed", async () => {
    const command = "/missing/rg needle file";
    const evaluation = await evaluate(command, true);

    expect(evaluation.categories.map((category) => category.id)).toContain(
      "policy.review.guard.executable_unavailable",
    );
    await expectStructurallyAllowedOrHostUnavailable(command, evaluation);
  });

  test("rejects a compound command with an unmatched segment", async () => {
    const command = "/missing/rg needle file | definitely-unknown-command";
    const policy = policyFromUnknown(
      { rules: { allow: [{ match: "^/missing/rg(?:\\s|$).*", scope: "segment", priority: 100 }] } },
      defaultPolicy().rules,
    );
    const evaluation = await evaluateRules(policy.rules, { command });

    await expect(expectStructurallyAllowedOrHostUnavailable(command, evaluation)).rejects.toThrow();
  });

  test("accepts unavailable xcrun resolution but rejects an untrusted selector", async () => {
    const unavailable = "xcrun /definitely/missing/tool";
    const unavailableEvaluation = await evaluate(unavailable, true);
    expect(unavailableEvaluation.categories.map((category) => category.id)).toContain(
      "policy.review.guard.xcrun_unavailable",
    );
    await expectStructurallyAllowedOrHostUnavailable(unavailable, unavailableEvaluation);

    const untrusted = "xcrun --sdk definitely-not-an-apple-sdk swift -typecheck Source.swift";
    const untrustedEvaluation = await evaluate(untrusted, true);
    expect(untrustedEvaluation.categories.map((category) => category.id)).toContain(
      "policy.review.guard.xcrun_selection",
    );
    await expect(expectStructurallyAllowedOrHostUnavailable(untrusted, untrustedEvaluation)).rejects.toThrow();
  });

  test("rejects an xcrun tool that resolves outside the selected Xcode developer directory", async () => {
    const command = "xcrun /bin/sh -c 'echo ok'";
    const evaluation = await evaluate(command, true);

    expect(evaluation.categories.map((category) => category.id)).toContain(
      "policy.review.guard.xcrun_identity",
    );
    await expect(expectStructurallyAllowedOrHostUnavailable(command, evaluation)).rejects.toThrow();
  });

  test("does not confuse equal byte ranges from different nested shell analyses", async () => {
    const command = "xcrun sh -c 'echo'; xcrun sh -c 'nope'";
    const nestedSegments = (await analyzeShell(command)).segments.filter((segment) => segment.nested);
    expect(nestedSegments.map((segment) => segment.source)).toEqual(["echo", "nope"]);
    expect(nestedSegments[0]?.startByte).toBe(nestedSegments[1]?.startByte);
    expect(nestedSegments[0]?.endByte).toBe(nestedSegments[1]?.endByte);
    const policy = policyFromUnknown(
      { rules: { allow: [
        { match: "^xcrun(?:\\s|$).*", scope: "segment", priority: 100 },
        { match: "^echo$", scope: "segment", priority: 100 },
      ] } },
      defaultPolicy().rules,
    );
    const evaluation = await evaluateRules(policy.rules, { command });
    const hostUnavailableEvaluation: RuleEvaluation = {
      ...evaluation,
      decision: "review",
      categories: [
        ...evaluation.categories.filter((category) => category.id.startsWith("policy.allow.")),
        { id: "policy.review.guard.xcrun_unavailable", score: 0.5 },
      ],
    };

    await expect(
      expectStructurallyAllowedOrHostUnavailable(command, hostUnavailableEvaluation),
    ).rejects.toThrow();
  });
});
