import type { PluginInput } from "@opencode-ai/plugin";
import { evaluationWithRiskToolScan, scanWithRiskTool, verdictFromRiskToolScan } from "./risk-tool";
import { reviewWithAiSdk } from "./reviewer";
import { evaluateRulesFromAnalysis } from "./rules";
import { fetchSessionContext } from "./session-context";
import { analyzeShell } from "./shell-analysis";
import type { ApprovalVerdict, CommandContext, ResolvedPolicy, RuleEvaluation } from "./types";
import { verdictFromReview, verdictFromRules } from "./verdict";

type DecisionPipelineInput = {
  readonly policy: ResolvedPolicy;
  readonly context: CommandContext;
  readonly client: PluginInput["client"] | undefined;
};

const terminalRuleVerdict = (evaluation: RuleEvaluation): ApprovalVerdict | undefined => {
  if (evaluation.matchedRules.length === 0) return undefined;
  return verdictFromRules(evaluation);
};

export const resolveCommandVerdict = async ({
  policy,
  context,
  client,
}: DecisionPipelineInput): Promise<ApprovalVerdict> => {
  const analysis = await analyzeShell(context.command);
  const userRules = policy.rules.filter((rule) => rule.origin === "user");
  const builtinRules = policy.rules.filter((rule) => rule.origin === "builtin");
  const userEvaluation = evaluateRulesFromAnalysis(userRules, context.command, analysis);
  const userVerdict = terminalRuleVerdict(userEvaluation);
  if (userVerdict) return userVerdict;

  let evaluation = userEvaluation;
  if (userEvaluation.matchedRules.length === 0 && userEvaluation.reasons.length === 0) {
    const builtinEvaluation = evaluateRulesFromAnalysis(builtinRules, context.command, analysis);
    const builtinVerdict = terminalRuleVerdict(builtinEvaluation);
    if (builtinVerdict) return builtinVerdict;
    evaluation = builtinEvaluation;
  }

  const riskToolScan = await scanWithRiskTool(policy, context);
  const riskToolVerdict = verdictFromRiskToolScan(riskToolScan);
  if (riskToolVerdict) return riskToolVerdict;

  const reviewEvaluation = evaluationWithRiskToolScan(evaluation, riskToolScan);
  const transcript = await fetchSessionContext(client, context.sessionID, policy.review.contextMessages);
  return verdictFromReview(
    await reviewWithAiSdk(policy, context, reviewEvaluation, transcript),
    reviewEvaluation,
  );
};
