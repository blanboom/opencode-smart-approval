import type { CommandContext, CommandRule, EvaluationDecision, MatchedRule, RuleCategory, RuleEvaluation } from "./types";

const categoryForRule = (rule: CommandRule): RuleCategory => {
  const score = rule.decision === "block" ? 1 : rule.decision === "review" ? 0.5 : 0.05;
  return { id: `policy.${rule.decision}.${rule.label}`, score };
};

const reasonForRule = (rule: CommandRule): string => {
  return rule.reason ?? `matched ${rule.label} command approval rule`;
};

const decisionPriority = (decision: EvaluationDecision): number => {
  switch (decision) {
    case "block":
      return 3;
    case "review":
      return 2;
    case "allow":
      return 1;
    default:
      return 0;
  }
};

const strongestDecision = (rules: readonly CommandRule[]): EvaluationDecision => {
  if (rules.length === 0) return "review";
  return rules.reduce((strongest, rule) =>
    decisionPriority(rule.decision) > decisionPriority(strongest) ? rule.decision : strongest,
  "allow" as EvaluationDecision);
};

export const evaluateRules = (
  rules: readonly CommandRule[],
  context: Pick<CommandContext, "command">,
): RuleEvaluation => {
  const matchedRules: MatchedRule[] = [];
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (!rule) continue;
    if (new RegExp(rule.match, "u").test(context.command)) {
      matchedRules.push({ ...rule, index });
      // block is final; review forces LLM but allow rules can still override later
      if (rule.decision === "block") break;
    }
  }
  return {
    decision: matchedRules.length === 0 ? "review" : strongestDecision(matchedRules),
    matchedRules,
    categories: matchedRules.map(categoryForRule),
    reasons: matchedRules.map(reasonForRule),
  };
};