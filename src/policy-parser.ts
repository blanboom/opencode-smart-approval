import { DEFAULT_TIRITH, DEFAULT_SELF_PROTECTION } from "./default-config";
export { parsePolicyJsonc, stripJsonComments } from "./policy-jsonc";
import { parsePolicyV3Document, type PolicyV3Document } from "./policy-v3-schema";
import { compileRule, ruleIdentity } from "./rule-compiler";
import type { ApprovalPolicy, CommandRule, ReviewConfig, RuleDecision } from "./types";

type PolicyResolution = {
  readonly policy: ApprovalPolicy;
  readonly allowLocalConfig: boolean;
};

const ownValue = <T extends object, K extends keyof T>(value: T, key: K): T[K] | undefined => {
  return Object.hasOwn(value, key) ? value[key] : undefined;
};

const compileRuleList = (
  rules: NonNullable<PolicyV3Document["rules"]>["deny"],
  decision: RuleDecision,
  field: "deny" | "review" | "allow",
): readonly CommandRule[] => (rules ?? []).map((rule, index) => compileRule({
  label: `${field}[${String(index)}]`,
  match: rule.match,
  decision,
  origin: "user",
  scope: rule.scope ?? "command",
  priority: rule.priority ?? 0,
  ...(rule.reason === undefined ? {} : { reason: rule.reason }),
}));

const mergeRules = (
  userRules: readonly CommandRule[],
  fallbackRules: readonly CommandRule[],
): readonly CommandRule[] => {
  const identities = new Set<string>();
  return [...userRules, ...fallbackRules].filter((rule) => {
    const identity = ruleIdentity(rule);
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
};

const reviewFromDocument = (review: PolicyV3Document["review"]): ReviewConfig => {
  const model = ownValue(review, "model");
  const prompt = ownValue(review, "prompt");
  return {
    timeoutMs: ownValue(review, "timeout_ms") ?? 45_000,
    contextMessages: ownValue(review, "context_messages") ?? 20,
    cleanupSession: ownValue(review, "cleanup_session") ?? true,
    ...(model === undefined ? {} : { model }),
    ...(prompt === undefined ? {} : { prompt }),
  };
};

export const policyDocumentFromUnknown = (
  value: unknown,
  fallbackRules: readonly CommandRule[],
): PolicyResolution => {
  const document = parsePolicyV3Document(value);
  const rules = ownValue(document, "rules");
  const userRules = [
    ...compileRuleList(rules === undefined ? undefined : ownValue(rules, "deny"), "block", "deny"),
    ...compileRuleList(rules === undefined ? undefined : ownValue(rules, "review"), "review", "review"),
    ...compileRuleList(rules === undefined ? undefined : ownValue(rules, "allow"), "allow", "allow"),
  ];
  const tirith = ownValue(document, "tirith");
  const tirithPath = tirith === undefined ? undefined : ownValue(tirith, "path");
  const selfProtection = ownValue(document, "self_protection");
  return {
    allowLocalConfig: ownValue(document, "allow_local_config") ?? false,
    policy: {
      review: reviewFromDocument(document.review),
      tirith: {
        enabled: tirith === undefined ? DEFAULT_TIRITH.enabled : ownValue(tirith, "enabled") ?? DEFAULT_TIRITH.enabled,
        timeoutMs: tirith === undefined ? DEFAULT_TIRITH.timeoutMs : ownValue(tirith, "timeout_ms") ?? DEFAULT_TIRITH.timeoutMs,
        failOpen: tirith === undefined ? DEFAULT_TIRITH.failOpen : ownValue(tirith, "fail_open") ?? DEFAULT_TIRITH.failOpen,
        ...(tirithPath === undefined ? {} : { path: tirithPath }),
      },
      selfProtection: {
        enabled: selfProtection === undefined
          ? DEFAULT_SELF_PROTECTION.enabled
          : ownValue(selfProtection, "enabled") ?? DEFAULT_SELF_PROTECTION.enabled,
      },
      rules: mergeRules(userRules, fallbackRules),
    },
  };
};

export const policyFromUnknown = (value: unknown, fallbackRules: readonly CommandRule[]): ApprovalPolicy => {
  return policyDocumentFromUnknown(value, fallbackRules).policy;
};
