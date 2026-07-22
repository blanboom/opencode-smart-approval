import type { ApprovalVerdict, ReviewResponse, RuleEvaluation } from "./types";
import { renderCommandApprovalError } from "./user-facing";
export { isCommandApprovalError } from "./user-facing";
export type { CommandApprovalError } from "./user-facing";

class VerdictRenderInvariantError extends Error {
  readonly name = "VerdictRenderInvariantError";
  constructor() {
    super("ordinary approval error rendering failed");
  }
}

const assertNever = (value: never): never => {
  void value;
  throw new VerdictRenderInvariantError();
};

export const verdictFromRules = (evaluation: RuleEvaluation): ApprovalVerdict | undefined => {
  if (evaluation.decision === "review") return undefined;
  return {
    decision: evaluation.decision === "allow" ? "allow" : "block",
    source: "rule",
    reasonSource: "rule",
    riskLevel: evaluation.decision === "allow" ? "low" : "critical",
    userAuthorization: "unknown",
    categories: evaluation.categories,
    reasons: evaluation.reasons,
    matchedRuleLabels: evaluation.matchedRules.map((rule) => rule.label),
  };
};

export const verdictFromReview = (review: ReviewResponse, evaluation: RuleEvaluation): ApprovalVerdict => {
  return {
    decision: review.outcome === "allow" ? "allow" : "block",
    source: review.categories.some((category) =>
      category.id === "security.reviewer_unavailable" || category.id === "security.reviewer_lifecycle")
      ? "fail_closed"
      : "review",
    reasonSource: review.categories.some((category) => category.id === "security.reviewer_lifecycle")
      ? "lifecycle"
      : "reviewer",
    riskLevel: review.riskLevel,
    userAuthorization: review.userAuthorization,
    categories: review.categories,
    reasons: review.reasons,
    matchedRuleLabels: evaluation.matchedRules.map((rule) => rule.label),
  };
};

export const enforceVerdict = (tool: string, verdict: ApprovalVerdict): void => {
  if (verdict.decision === "allow") return;
  const rendered = renderCommandApprovalError({ kind: "ordinary", tool, verdict });
  switch (rendered.kind) {
    case "error":
      throw rendered.error;
    case "confirmation_failure":
      throw new VerdictRenderInvariantError();
    default:
      return assertNever(rendered);
  }
};
