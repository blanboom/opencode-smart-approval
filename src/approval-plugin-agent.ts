import type { Hooks } from "@opencode-ai/plugin";
import type { ApprovalAgentConfig, ApprovalAgentRuntimeExpectation } from "./approval-agent";
import {
  registerApprovalAgent,
  trustedPolicyRouting,
  type TrustedPolicyRouting,
} from "./approval-agent-registration";
import type { ReviewConfig } from "./types";

type ConfigHook = NonNullable<Hooks["config"]>;

export type ExpectedApprovalAgent = {
  readonly config: ApprovalAgentConfig;
  readonly runtime: ApprovalAgentRuntimeExpectation;
  readonly trustedPolicy: TrustedPolicyRouting;
};

export type CreateExpectedApprovalAgentInput = {
  readonly config: ApprovalAgentConfig;
  readonly runtime: ApprovalAgentRuntimeExpectation;
  readonly trustedPolicySuffix: string | undefined;
};

export const createExpectedApprovalAgent = (
  input: CreateExpectedApprovalAgentInput,
): ExpectedApprovalAgent => Object.freeze({
  config: input.config,
  runtime: input.runtime,
  trustedPolicy: trustedPolicyRouting(input.trustedPolicySuffix),
});

export type ApprovalAgentConfigHookInput = {
  readonly reviewConfig: ReviewConfig | undefined;
  readonly runtime: ApprovalAgentRuntimeExpectation | undefined;
  readonly publish: (expected: ExpectedApprovalAgent | undefined) => void;
};

export const createApprovalAgentConfigHook = (input: ApprovalAgentConfigHookInput): ConfigHook => async (config) => {
  const registered = registerApprovalAgent(config, input.reviewConfig?.prompt, input.reviewConfig?.model);
  input.publish(input.runtime
    ? createExpectedApprovalAgent({
      config: registered,
      runtime: input.runtime,
      trustedPolicySuffix: input.reviewConfig?.prompt,
    })
    : undefined);
};
