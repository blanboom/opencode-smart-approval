import type { ProviderStep } from "../../test/fixtures/deterministic-openai-provider";

export const appendBaselineSteps = (
  steps: ProviderStep[],
  label: string,
  noncePath: string,
  reviewerModel: string,
): void => {
  steps.push(
    { kind: "function", model: "fixture-primary", responseId: `resp-${label}-primary-tool`, callId: `call-${label}-primary-bash`, toolName: "bash", argumentsJson: JSON.stringify({ command: "printf main-ok" }) },
    { kind: "function", model: reviewerModel, responseId: `resp-${label}-review-read`, callId: `call-${label}-review-read`, toolName: "opencode_smart_approval_read", argumentsJson: JSON.stringify({ path: noncePath, offset: 0 }) },
    { kind: "text", model: reviewerModel, responseId: `resp-${label}-review-verdict`, messageId: `msg-${label}-review-verdict`, text: JSON.stringify({ outcome: "allow", risk_level: "low", user_authorization: "unknown", categories: [{ id: "security.reviewed", score: 0.1 }], reasons: ["bounded command"] }) },
    { kind: "text", model: "fixture-primary", responseId: `resp-${label}-primary-final`, messageId: `msg-${label}-primary-final`, text: "main-ok" },
  );
};

export const appendRetainedProbeSteps = (
  steps: ProviderStep[],
  label: string,
  noncePath: string,
  reviewerModel: string,
): void => {
  steps.push(
    { kind: "function", model: reviewerModel, responseId: `resp-${label}-retained-read`, callId: `call-${label}-retained-read`, toolName: "opencode_smart_approval_read", argumentsJson: JSON.stringify({ path: noncePath, offset: 0 }) },
    { kind: "text", model: reviewerModel, responseId: `resp-${label}-retained-final`, messageId: `msg-${label}-retained-final`, text: "retained-probe-complete" },
  );
};
