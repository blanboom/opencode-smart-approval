import { expect } from "bun:test";
import { analyzeShell } from "../src/shell-analysis";
import type { RuleEvaluation } from "../src/types";

const hostUnavailableReviewCategories = new Set([
  "policy.review.guard.executable_unavailable",
  "policy.review.guard.xcrun_unavailable",
]);

export const expectStructurallyAllowedOrHostUnavailable = async (
  command: string,
  evaluation: RuleEvaluation,
): Promise<void> => {
  const analysis = await analyzeShell(command);
  expect(analysis.issues).toEqual([]);
  expect(evaluation.matchedRules.length).toBeGreaterThan(0);
  expect(evaluation.matchedRules.every((rule) => rule.decision === "allow")).toBe(true);
  for (const segment of analysis.segments) {
    const allowed = evaluation.matchedRules.some((rule) =>
      rule.decision === "allow" && (
        (analysis.segments.length === 1 && rule.scope === "command") ||
        (rule.scope === "segment" && rule.segmentSource === segment.source &&
          rule.startByte === segment.startByte && rule.endByte === segment.endByte)
      )
    );
    expect(allowed).toBe(true);
  }

  const escalationCategories = evaluation.categories.filter((category) => !category.id.startsWith("policy.allow."));
  if (evaluation.decision === "allow") {
    expect(escalationCategories).toEqual([]);
    return;
  }

  expect(evaluation.decision).toBe("review");
  expect(escalationCategories.length).toBeGreaterThan(0);
  expect(escalationCategories.every((category) => hostUnavailableReviewCategories.has(category.id))).toBe(true);
};
