import type { Hooks, PluginInput, PluginModule } from "@opencode-ai/plugin";
import { buildCommandContext } from "./context";
import { loadOrInitializePolicy, policyCandidatePaths } from "./config";
import { findConfigWrite } from "./config-self-protection";
import { resolveCommandVerdict } from "./decision-pipeline";
import { CommandApprovalError, enforceVerdict } from "./verdict";

type ToolExecuteBefore = NonNullable<Hooks["tool.execute.before"]>;
type ToolExecuteInput = Parameters<ToolExecuteBefore>[0];
type ToolExecuteOutput = Parameters<ToolExecuteBefore>[1];
export type ApprovalPluginInput = Pick<PluginInput, "directory"> & Partial<Pick<PluginInput, "client">>;

const shellToolNames = new Set(["bash", "shell", "shell_command", "exec_command"]);
const protectedFileToolNames = new Set(["write", "edit", "apply_patch", "patch"]);

const handlesTool = (tool: string): boolean => {
  return shellToolNames.has(tool) || protectedFileToolNames.has(tool);
};

export const createHook = (directory: string, client?: PluginInput["client"]): ToolExecuteBefore => {
  const loaded = loadOrInitializePolicy(directory);
  const protectedPolicyPaths = policyCandidatePaths(directory);
  return async (toolInput: ToolExecuteInput, toolOutput: ToolExecuteOutput) => {
    if (!handlesTool(toolInput.tool)) return;
    const policy = loaded.policy;
    if (policy.selfProtection.enabled) {
      const finding = await findConfigWrite({
        tool: toolInput.tool,
        args: toolOutput.args,
        directory,
        policyPaths: protectedPolicyPaths,
      });
      if (finding) {
        enforceVerdict(toolInput.tool, {
          decision: "block",
          source: "rule",
          riskLevel: "critical",
          userAuthorization: "unknown",
          categories: [{ id: "security.config_self_protection", score: 1 }],
          reasons: [finding.reason],
          matchedRuleLabels: [],
        });
        return;
      }
    }
    if (!shellToolNames.has(toolInput.tool)) return;
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
    if (!context) {
      enforceVerdict(toolInput.tool, {
        decision: "block",
        source: "fail_closed",
        riskLevel: "high",
        userAuthorization: "unknown",
        categories: [{ id: "security.command_unavailable", score: 1 }],
        reasons: ["shell command is missing from the handled tool arguments"],
        matchedRuleLabels: [],
      });
      return;
    }
    try {
      enforceVerdict(toolInput.tool, await resolveCommandVerdict({ policy, context, client }));
    } catch (error) {
      if (error instanceof CommandApprovalError) throw error;
      const message = error instanceof Error ? error.message : "unknown shell analysis failure";
      enforceVerdict(toolInput.tool, {
        decision: "block",
        source: "fail_closed",
        riskLevel: "high",
        userAuthorization: "unknown",
        categories: [{ id: "security.shell_parser_unavailable", score: 1 }],
        reasons: [`shell analysis unavailable: ${message}`],
        matchedRuleLabels: [],
      });
    }
  };
};

export default {
  id: "opencode-smart-approval",
  server: async (input: ApprovalPluginInput) => {
    return {
      "tool.execute.before": createHook(input.directory, input.client),
    };
  },
} satisfies PluginModule;
