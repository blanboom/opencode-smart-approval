import type { Hooks, PluginInput, PluginModule } from "@opencode-ai/plugin";
import { buildCommandContext } from "./context";
import { loadOrInitializePolicy } from "./config";
import { evaluationWithRiskToolScan, scanWithRiskTool, verdictFromRiskToolScan } from "./risk-tool";
import { evaluateRules } from "./rules";
import { reviewWithAiSdk } from "./reviewer";
import { enforceVerdict, verdictFromReview, verdictFromRules } from "./verdict";
import { fetchSessionContext } from "./session-context";

type ToolExecuteBefore = NonNullable<Hooks["tool.execute.before"]>;
type ToolExecuteInput = Parameters<ToolExecuteBefore>[0];
type ToolExecuteOutput = Parameters<ToolExecuteBefore>[1];

const shellToolNames = new Set(["bash", "shell", "shell_command", "exec_command"]);

const handlesTool = (tool: string): boolean => {
  return shellToolNames.has(tool);
};

const createHook = (directory: string, client?: PluginInput["client"]): ToolExecuteBefore => {
  const loaded = loadOrInitializePolicy(directory);
  return async (toolInput: ToolExecuteInput, toolOutput: ToolExecuteOutput) => {
    if (!handlesTool(toolInput.tool)) return;
    const policy = loaded.policy;
    if (!loaded.ok) {
      enforceVerdict(toolInput.tool, {
        decision: "block",
        source: "fail_closed",
        riskLevel: "high",
        userAuthorization: "unknown",
        categories: [{ id: "security.policy_unavailable", score: 1 }],
        reasons: [`approval policy unavailable: ${loaded.error}`],
        matchedRuleLabels: [],
      });
      return;
    }
    const context = buildCommandContext(toolInput, toolOutput.args, directory, policy.review.maxScriptBytes);
    if (!context) return;
    const riskToolScan = await scanWithRiskTool(policy, context);
    const riskToolVerdict = verdictFromRiskToolScan(riskToolScan);
    if (riskToolVerdict) {
      enforceVerdict(toolInput.tool, riskToolVerdict);
      return;
    }
    const evaluation = evaluateRules(policy.rules, context);
    const ruleVerdict = verdictFromRules(evaluation);
    // block rules: immediate deny
    if (evaluation.decision === "block" && ruleVerdict) {
      enforceVerdict(toolInput.tool, ruleVerdict);
      return;
    }
    // allow rules: immediate pass (unless Tirith warned → review)
    if (evaluation.decision === "allow" && ruleVerdict && riskToolScan.action !== "warn") {
      enforceVerdict(toolInput.tool, ruleVerdict);
      return;
    }
    // review rules or unmatched or Tirith warn: send to LLM
    const reviewEvaluation = evaluationWithRiskToolScan(evaluation, riskToolScan);
    const transcript = await fetchSessionContext(client, toolInput.sessionID, policy.review.contextMessages);
    enforceVerdict(
      toolInput.tool,
      verdictFromReview(await reviewWithAiSdk(policy, context, reviewEvaluation, transcript), reviewEvaluation),
    );
  };
};

export default {
  id: "opencode-smart-approval",
  server: async (input: PluginInput) => {
    return {
      "tool.execute.before": createHook(input.directory, input.client),
    };
  },
} satisfies PluginModule;