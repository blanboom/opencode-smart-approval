import type { EvaluationDecision, RuleCategory } from "./types";

export type GuardFinding = {
  readonly decision: Exclude<EvaluationDecision, "allow">;
  readonly category: RuleCategory;
  readonly reason: string;
};

export const guardFinding = (
  decision: GuardFinding["decision"],
  id: string,
  reason: string,
): GuardFinding => ({
  decision,
  category: { id: `policy.${decision}.guard.${id}`, score: decision === "block" ? 1 : 0.5 },
  reason,
});
