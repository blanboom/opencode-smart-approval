import type { ApprovalVerdict, ReviewResponse, RuleEvaluation } from "./types";

export class CommandApprovalError extends Error {
  constructor(
    readonly tool: string,
    readonly verdict: ApprovalVerdict,
  ) {
    super(`[CommandApproval] blocked ${tool}: ${verdict.reasons.join("; ") || verdict.source}`);
    this.name = "CommandApprovalError";
  }
}

export const verdictFromRules = (evaluation: RuleEvaluation): ApprovalVerdict | undefined => {
  if (evaluation.decision === "review") return undefined;
  return {
    decision: evaluation.decision === "allow" ? "allow" : "block",
    source: "rule",
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
    source: review.categories.some((category) => category.id === "security.reviewer_unavailable")
      ? "fail_closed"
      : "review",
    riskLevel: review.riskLevel,
    userAuthorization: review.userAuthorization,
    categories: review.categories,
    reasons: review.reasons,
    matchedRuleLabels: evaluation.matchedRules.map((rule) => rule.label),
  };
};

export const enforceVerdict = (tool: string, verdict: ApprovalVerdict): void => {
  if (verdict.decision === "allow") return;
  throw new CommandApprovalError(tool, verdict);
};
