import type { CommandRule, RuleDecision, RuleOrigin, RuleScope } from "./types";

export type RuleDefinition = {
  readonly label: string;
  readonly match: string;
  readonly decision: RuleDecision;
  readonly scope?: RuleScope;
  readonly priority?: number;
  readonly origin?: RuleOrigin;
  readonly reason?: string;
};

export const compileRule = (definition: RuleDefinition): CommandRule => {
  const regex = new RegExp(definition.match, "u");
  const reason = definition.reason;
  return {
    label: definition.label,
    match: definition.match,
    decision: definition.decision,
    scope: definition.scope ?? "command",
    priority: definition.priority ?? 0,
    origin: definition.origin ?? "builtin",
    regex,
    ...(reason ? { reason } : {}),
  };
};

export const ruleIdentity = (rule: CommandRule): string => {
  return [rule.origin, rule.decision, rule.scope, String(rule.priority), rule.match].join("\u0000");
};
