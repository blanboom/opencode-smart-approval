import type { ProviderStep } from "../../test/fixtures/deterministic-openai-provider";

export type ConfirmationScenarioKind =
  | "happy-replay"
  | "preauthorization"
  | "generic"
  | "stale"
  | "boundary-eviction"
  | "two-users"
  | "synthetic"
  | "assistant-copy"
  | "altered-effect";

export type ConfirmationCommands = Readonly<{ readonly primary: string; readonly altered?: string }>;

const needsConfirmation = JSON.stringify({
  outcome: "needs_confirmation",
  risk_level: "high",
  user_authorization: "unknown",
  categories: [{ id: "security.external-disclosure", score: 0.9 }],
  reasons: ["explicit consent is required"],
  confirmation: {
    action: "Create the isolated confirmation marker",
    data: "One literal confirmed marker",
    destination: "The isolated local workspace",
    risk: "The command creates one local file",
  },
});

const allow = JSON.stringify({
  outcome: "allow",
  risk_level: "low",
  user_authorization: "high",
  categories: [{ id: "security.confirmed-review", score: 0.1 }],
  reasons: ["the confirmed effect was reviewed again"],
});

const deny = JSON.stringify({
  outcome: "deny",
  risk_level: "high",
  user_authorization: "unknown",
  categories: [{ id: "security.unconfirmed-retry", score: 0.9 }],
  reasons: ["the retry has no valid one-shot proof"],
});

const primaryFunction = (label: string, phase: string, command: string): ProviderStep => ({
  kind: "function",
  model: "fixture-primary",
  responseId: `resp-${label}-${phase}-primary-tool`,
  callId: `call-${label}-${phase}-primary-bash`,
  toolName: "bash",
  argumentsJson: JSON.stringify({ command }),
});

const reviewerRead = (label: string, phase: string, noncePath: string): ProviderStep => ({
  kind: "function",
  model: "fixture-reviewer",
  responseId: `resp-${label}-${phase}-review-read`,
  callId: `call-${label}-${phase}-review-read`,
  toolName: "opencode_smart_approval_read",
  argumentsJson: JSON.stringify({ path: noncePath, offset: 0 }),
});

const reviewerText = (label: string, phase: string, text: string): ProviderStep => ({
  kind: "text",
  model: "fixture-reviewer",
  responseId: `resp-${label}-${phase}-review-text`,
  messageId: `msg-${label}-${phase}-review-text`,
  text,
});

const primaryText = (label: string, phase: string): ProviderStep => ({
  kind: "text",
  model: "fixture-primary",
  responseId: `resp-${label}-${phase}-primary-final`,
  messageId: `msg-${label}-${phase}-primary-final`,
  text: `${label}-${phase}-settled`,
});

const appendChallenge = (
  steps: ProviderStep[],
  label: string,
  phase: string,
  command: string,
  noncePath: string,
  echoAuthorization: boolean,
): void => {
  steps.push(primaryFunction(label, phase, command));
  steps.push(reviewerRead(label, phase, noncePath));
  steps.push(reviewerText(label, phase, needsConfirmation));
  steps.push(echoAuthorization ? {
    kind: "authorization_echo",
    model: "fixture-primary",
    responseId: `resp-${label}-${phase}-primary-echo`,
    messageId: `msg-${label}-${phase}-primary-echo`,
    prefix: "assistant-copy:",
  } : primaryText(label, phase));
};

const appendRejectedRetry = (steps: ProviderStep[], label: string, command: string): void => {
  steps.push(primaryFunction(label, "retry", command), primaryText(label, "retry"));
};

const appendReviewedRetry = (
  steps: ProviderStep[],
  label: string,
  phase: string,
  command: string,
  noncePath: string,
  verdict: string,
): void => {
  steps.push(
    primaryFunction(label, phase, command),
    reviewerRead(label, phase, noncePath),
    reviewerText(label, phase, verdict),
    primaryText(label, phase),
  );
};

export const appendConfirmationScenarioSteps = (
  steps: ProviderStep[],
  kind: ConfirmationScenarioKind,
  commands: ConfirmationCommands,
  noncePath: string,
): number => {
  const before = steps.length;
  appendChallenge(steps, kind, "initial", commands.primary, noncePath, kind === "assistant-copy");
  switch (kind) {
    case "happy-replay":
      appendReviewedRetry(steps, kind, "confirmed", commands.primary, noncePath, allow);
      appendReviewedRetry(steps, kind, "replay", commands.primary, noncePath, deny);
      break;
    case "preauthorization":
      break;
    case "stale":
      appendChallenge(steps, kind, "replacement", commands.altered ?? "", noncePath, false);
      appendRejectedRetry(steps, kind, commands.altered ?? "");
      break;
    case "altered-effect":
      appendReviewedRetry(steps, kind, "altered", commands.altered ?? "", noncePath, deny);
      break;
    default:
      appendRejectedRetry(steps, kind, commands.primary);
      break;
  }
  return steps.length - before;
};
