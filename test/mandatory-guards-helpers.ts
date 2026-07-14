import { defaultPolicy } from "../src/default-config";
import { policyFromUnknown } from "../src/policy-parser";
import { evaluateRules } from "../src/rules";

const broadUserPolicy = () =>
  policyFromUnknown(
    { rules: { allow: [{ match: ".*", scope: "segment", priority: 100 }] } },
    defaultPolicy().rules,
  );

export const evaluate = (command: string, useBroadPolicy = false, cwd = process.cwd()) => {
  const context = { command, cwd };
  return evaluateRules(useBroadPolicy ? broadUserPolicy().rules : defaultPolicy().rules, context);
};
