import { z } from "zod";
import {
  APPROVAL_AGENT_DESCRIPTION,
  APPROVAL_AGENT_NAME,
  APPROVAL_AGENT_SECURITY_CONTRACT,
  APPROVAL_AGENT_TRUSTED_POLICY_CLOSE,
  APPROVAL_AGENT_TRUSTED_POLICY_OPEN,
  ApprovalAgentConfigSchema,
  ApprovalAgentContractError,
  type ApprovalAgentConfig,
} from "./approval-agent-contract";

const RootConfigBoundarySchema = z.looseObject({
  small_model: z.string().optional(),
  agent: z.record(z.string(), z.unknown()).optional(),
});

export type TrustedPolicyRouting =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly suffix: string };

const ABSENT_TRUSTED_POLICY = Object.freeze({ kind: "absent" } as const);

export const trustedPolicyRouting = (trustedPolicySuffix?: string): TrustedPolicyRouting => {
  const suffix = trustedPolicySuffix?.trim();
  return suffix
    ? Object.freeze({ kind: "present", suffix })
    : ABSENT_TRUSTED_POLICY;
};

const buildApprovalAgentPrompt = (trustedPolicySuffix?: string): string => {
  const routing = trustedPolicyRouting(trustedPolicySuffix);
  if (routing.kind === "absent") return APPROVAL_AGENT_SECURITY_CONTRACT;
  return [
    APPROVAL_AGENT_SECURITY_CONTRACT,
    APPROVAL_AGENT_TRUSTED_POLICY_OPEN,
    routing.suffix,
    APPROVAL_AGENT_TRUSTED_POLICY_CLOSE,
  ].join("\n\n");
};

const approvalAgentConfig = (model: string | undefined, trustedPolicySuffix?: string): ApprovalAgentConfig => {
  const base = {
    description: APPROVAL_AGENT_DESCRIPTION,
    prompt: buildApprovalAgentPrompt(trustedPolicySuffix),
    mode: "subagent",
    steps: 4,
    temperature: 0,
    permission: {
      "*": "deny",
      external_directory: "deny",
      opencode_smart_approval_read: "allow",
    },
  } as const;
  const candidate = model === undefined ? base : { ...base, model };
  const parsed = ApprovalAgentConfigSchema.safeParse(candidate);
  if (!parsed.success) throw new ApprovalAgentContractError("invalid_config");
  return candidate;
};

const immutableApprovalAgentConfig = (model: string | undefined, trustedPolicySuffix?: string): ApprovalAgentConfig => {
  const expected = approvalAgentConfig(model, trustedPolicySuffix);
  Object.freeze(expected.permission);
  return Object.freeze(expected);
};

export const registerApprovalAgent = (
  config: unknown,
  trustedPolicySuffix?: string,
  policyModel?: string,
): ApprovalAgentConfig => {
  if (typeof config !== "object" || config === null) throw new ApprovalAgentContractError("invalid_config");
  const parsed = RootConfigBoundarySchema.safeParse(config);
  if (!parsed.success) throw new ApprovalAgentContractError("invalid_config");
  const model = policyModel ?? parsed.data.small_model;
  const registered = approvalAgentConfig(model, trustedPolicySuffix);
  const expected = immutableApprovalAgentConfig(model, trustedPolicySuffix);
  const agents = { ...parsed.data.agent, [APPROVAL_AGENT_NAME]: registered };
  if (!Reflect.set(config, "agent", agents)) throw new ApprovalAgentContractError("config_mutation_failed");
  return expected;
};
