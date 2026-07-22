import type { ConfirmationValues } from "../../src/confirmation-renderer";
import type { ApprovalVerdict, RuleCategory, UserFacingReasonSource } from "../../src/types";

export const verdict = (
  reasonSource: UserFacingReasonSource,
  reasons: readonly string[],
  categories: readonly RuleCategory[] = [],
): ApprovalVerdict => ({
  decision: "block",
  source: reasonSource === "tirith" ? "risk_tool" : "fail_closed",
  reasonSource,
  riskLevel: "high",
  userAuthorization: "unknown",
  categories,
  reasons,
  matchedRuleLabels: ["raw-label-must-not-escape"],
});

export const challenge = (values: ConfirmationValues, replaced = false) => ({
  values,
  effectSha256: "a".repeat(64),
  disclosureSha256: "b".repeat(64),
  token: "C".repeat(43),
  replaced,
});
