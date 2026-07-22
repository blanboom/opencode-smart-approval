import type { Hooks, PluginInput, PluginModule } from "@opencode-ai/plugin";
import {
  createApprovalPluginIntegration,
  type ApprovalPluginInput,
} from "./approval-plugin-integration";
import { commandContextFromArgs } from "./context";
import { loadOrInitializePolicy } from "./config";
import type { PolicyLoadResult } from "./config";
import { findConfigWrite } from "./config-self-protection";
import { resolveCommandVerdict } from "./decision-pipeline";
import { analyzeShell } from "./shell-analysis";
import { enforceVerdict, isCommandApprovalError } from "./verdict";
import type { OpenCodeReviewerRuntime } from "./opencode-reviewer";
import type { ConfirmationService } from "./confirmation-service";
import type { ApprovalRootClient } from "./opencode-client-adapter";

type ToolExecuteBefore = NonNullable<Hooks["tool.execute.before"]>;
type ToolExecuteInput = Parameters<ToolExecuteBefore>[0];
type ToolExecuteOutput = Parameters<ToolExecuteBefore>[1];
export type { ApprovalPluginInput } from "./approval-plugin-integration";
export {
  APPROVAL_READ_TOOL_NAME,
  createApprovalPluginIntegration,
  type ApprovalHostEnvironment,
  type ApprovalPluginIntegration,
  type ApprovalPluginIntegrationOptions,
  type ApprovalToolHookFactory,
  type ApprovalToolHookFactoryInput,
  type ExpectedApprovalAgent,
} from "./approval-plugin-integration";

const shellToolNames = new Set(["bash", "shell", "shell_command", "exec_command"]);
const protectedFileToolNames = new Set(["write", "edit", "apply_patch", "patch"]);

const handlesTool = (tool: string): boolean => {
  return shellToolNames.has(tool) || protectedFileToolNames.has(tool);
};

class HookInvariantError extends Error {
  readonly name = "HookInvariantError";
  constructor() {
    super("unreachable config self-protection finding");
  }
}

class PluginInputError extends TypeError {
  readonly name = "PluginInputError";
  readonly code = "client_unavailable";

  constructor() {
    super();
    Object.freeze(this);
  }
}

const assertNever = (value: never): never => {
  void value;
  throw new HookInvariantError();
};

const objectField = (input: unknown, key: string): unknown => {
  return typeof input === "object" && input !== null ? Reflect.get(input, key) : undefined;
};

const captureApprovalRootClient = (input: unknown): ApprovalRootClient | undefined => {
  const app = objectField(input, "app");
  const session = objectField(input, "session");
  const agents = objectField(app, "agents");
  const log = objectField(app, "log");
  const messages = objectField(session, "messages");
  const create = objectField(session, "create");
  const prompt = objectField(session, "prompt");
  const abort = objectField(session, "abort");
  const deleteSession = objectField(session, "delete");
  if (
    typeof agents !== "function"
    || typeof log !== "function"
    || typeof messages !== "function"
    || typeof create !== "function"
    || typeof prompt !== "function"
    || typeof abort !== "function"
    || typeof deleteSession !== "function"
  ) return undefined;
  return Object.freeze({
    app: Object.freeze({
      agents: async (options) => Reflect.apply(agents, app, [options]),
      log: async (options) => Reflect.apply(log, app, [options]),
    }),
    session: Object.freeze({
      messages: async (options) => Reflect.apply(messages, session, [options]),
      create: async (options) => Reflect.apply(create, session, [options]),
      prompt: async (options) => Reflect.apply(prompt, session, [options]),
      abort: async (options) => Reflect.apply(abort, session, [options]),
      delete: async (options) => Reflect.apply(deleteSession, session, [options]),
    }),
  } satisfies ApprovalRootClient);
};

const productionPluginInput = (input: ApprovalPluginInput): ApprovalPluginInput & { readonly client: ApprovalRootClient } => {
  try {
    const client = captureApprovalRootClient(objectField(input, "client"));
    if (!client) throw new PluginInputError();
    return {
      directory: input.directory,
      client,
      ...(input.project === undefined ? {} : { project: input.project }),
      ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
    };
  } catch (error) {
    if (error instanceof PluginInputError) throw error;
    throw new PluginInputError();
  }
};

export type CreateHookOptions = {
  readonly loadedPolicy?: PolicyLoadResult;
  readonly reviewerRuntime?: () => OpenCodeReviewerRuntime | undefined;
  readonly confirmationRuntime?: () => ConfirmationService | undefined;
};

export const createHook = (
  directory: string,
  options: CreateHookOptions = {},
): ToolExecuteBefore => {
  const loaded = options.loadedPolicy ?? loadOrInitializePolicy(directory);
  return async (toolInput: ToolExecuteInput, toolOutput: ToolExecuteOutput) => {
    if (!handlesTool(toolInput.tool)) return;
    const policy = loaded.policy;
    const isShellTool = shellToolNames.has(toolInput.tool);
    const contextResult = isShellTool ? commandContextFromArgs(toolInput, toolOutput.args, directory) : undefined;
    if (contextResult && !contextResult.ok) {
      enforceVerdict(toolInput.tool, {
        decision: "block",
        source: "fail_closed",
        reasonSource: "parser",
        riskLevel: "high",
        userAuthorization: "unknown",
        categories: [{ id: contextResult.code === "workdir_invalid" ? "security.workdir_unavailable" : "security.command_unavailable", score: 1 }],
        reasons: [contextResult.code === "workdir_invalid"
          ? "shell execution workdir is invalid"
          : "shell command is missing from the handled tool arguments"],
        matchedRuleLabels: [],
      });
      return;
    }
    const context = contextResult?.ok ? contextResult.value : undefined;
    try {
      const analysis = context ? await analyzeShell(context.command, context.cwd) : undefined;
      let forceReview = false;
      if (policy.selfProtection.enabled) {
        const finding = findConfigWrite({
          tool: toolInput.tool,
          args: toolOutput.args,
          directory: context?.cwd ?? directory,
          policyPaths: loaded.effectivePolicyPaths,
          ...(analysis ? { analysis } : {}),
        });
        switch (finding.action) {
          case "block":
            enforceVerdict(toolInput.tool, {
              decision: "block",
              source: "rule",
              reasonSource: "policy",
              riskLevel: "critical",
              userAuthorization: "unknown",
              categories: [{ id: "security.config_self_protection", score: 1 }],
              reasons: [finding.reason],
              matchedRuleLabels: [],
            });
            return;
          case "force_review":
            forceReview = true;
            break;
          case "none":
            break;
          default:
            return assertNever(finding);
        }
      }
      if (!isShellTool) return;
      if (!loaded.ok) {
        enforceVerdict(toolInput.tool, {
          decision: "block",
          source: "fail_closed",
          reasonSource: "policy",
          riskLevel: "high",
          userAuthorization: "unknown",
          categories: [{ id: "security.policy_unavailable", score: 1 }],
          reasons: ["policy_failure:unavailable"],
          matchedRuleLabels: [],
        });
        return;
      }
      if (!context || !analysis) throw new HookInvariantError();
      const confirmationService = options.confirmationRuntime?.();
      enforceVerdict(toolInput.tool, await resolveCommandVerdict({
        policy,
        context,
        reviewerRuntime: options.reviewerRuntime?.(),
        ...(confirmationService === undefined ? {} : { confirmationService }),
        analysis,
        forceReview,
      }));
    } catch (error) {
      if (isCommandApprovalError(error)) throw error;
      enforceVerdict(toolInput.tool, {
        decision: "block",
        source: "fail_closed",
        reasonSource: "parser",
        riskLevel: "high",
        userAuthorization: "unknown",
        categories: [{ id: "security.shell_parser_unavailable", score: 1 }],
        reasons: ["parser_failure:unavailable"],
        matchedRuleLabels: [],
      });
    }
  };
};

export default {
  id: "opencode-smart-approval",
  server: async (input: ApprovalPluginInput) => {
    const productionInput = productionPluginInput(input);
    const loaded = loadOrInitializePolicy(productionInput.directory);
    return createApprovalPluginIntegration(productionInput, {
      reviewConfig: loaded.policy.review,
      createToolExecuteBefore: ({ directory, reviewerRuntime, confirmationService }) =>
        createHook(directory, {
          loadedPolicy: loaded,
          reviewerRuntime,
          confirmationRuntime: confirmationService,
        }),
    }).hooks;
  },
} satisfies PluginModule;
