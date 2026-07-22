import {
  APPROVAL_AGENT_DESCRIPTION,
  APPROVAL_AGENT_NAME,
  APPROVAL_AGENT_PERMISSION_SUFFIX,
  registerApprovalAgent,
} from "../../src/approval-agent";
import { trustedPolicyRouting } from "../../src/approval-agent-registration";

export const REVIEW_DIRECTORY = "/workspace";
export const REVIEW_WORKTREE = "/workspace";
export const REVIEW_CHILD_ID = "child-session";
export const REVIEW_MESSAGE_ID = "assistant-message";
export const REVIEW_TITLE = "opencode-smart-approval review";

export const validCreatedSession = () => ({
  id: REVIEW_CHILD_ID,
  slug: "review-child",
  projectID: "project-id",
  directory: REVIEW_DIRECTORY,
  parentID: "parent-session",
  title: REVIEW_TITLE,
  version: "1.17.14",
  time: { created: 10, updated: 11 },
});

export const allowVerdict = () => ({
  outcome: "allow",
  risk_level: "low",
  user_authorization: "unknown",
  categories: [{ id: "security.reviewed", score: 0.1 }],
  reasons: ["bounded command"],
});

export const INVALID_CATEGORY_CASES = [
  ["uppercase", [{ id: "Security.reviewed", score: 0.1 }]],
  ["leading whitespace", [{ id: " security.reviewed", score: 0.1 }]],
  ["trailing whitespace", [{ id: "security.reviewed ", score: 0.1 }]],
  ["internal whitespace", [{ id: "security. reviewed", score: 0.1 }]],
  ["leading punctuation", [{ id: ".security.reviewed", score: 0.1 }]],
  ["slash", [{ id: "security/reviewed", score: 0.1 }]],
  ["colon", [{ id: "security:reviewed", score: 0.1 }]],
  ["control character", [{ id: "security.\u0000reviewed", score: 0.1 }]],
  ["Unicode", [{ id: "安全", score: 0.1 }]],
  ["129 characters", [{ id: `a${"b".repeat(128)}`, score: 0.1 }]],
  ["duplicate IDs with different scores", [
    { id: "security.duplicate", score: 0.1 },
    { id: "security.duplicate", score: 0.9 },
  ]],
] as const;

export const VALID_CATEGORY_CASES = [
  ["lowercase", [{ id: "security.reviewed", score: 0.1 }]],
  ["hyphen", [{ id: "security-reviewed", score: 0.1 }]],
  ["128 characters", [{ id: `a${"b".repeat(127)}`, score: 0.1 }]],
] as const;

const identity = (id: string) => ({
  id,
  sessionID: REVIEW_CHILD_ID,
  messageID: REVIEW_MESSAGE_ID,
});

export const validStepFinishPart = (total?: number) => ({
  ...identity("part-finish"),
  type: "step-finish",
  reason: "stop",
  cost: 0,
  tokens: {
    ...(total === undefined ? {} : { total }),
    input: 1,
    output: 2,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  },
});

export const validPromptResponse = (verdict: unknown = allowVerdict()) => ({
  info: {
    id: REVIEW_MESSAGE_ID,
    sessionID: REVIEW_CHILD_ID,
    role: "assistant",
    time: { created: 20, completed: 21 },
    parentID: "user-message",
    modelID: "reviewer-model",
    providerID: "reviewer-provider",
    agent: APPROVAL_AGENT_NAME,
    mode: APPROVAL_AGENT_NAME,
    path: { cwd: REVIEW_DIRECTORY, root: REVIEW_WORKTREE },
    cost: 0,
    tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  },
  parts: [
    { ...identity("part-start"), type: "step-start" },
    { ...identity("part-text"), type: "text", text: JSON.stringify(verdict), time: { start: 20, end: 21 } },
    validStepFinishPart(),
  ],
});

const ignoredBranchVerdict = (): string => JSON.stringify({
  ...allowVerdict(),
  outcome: "deny",
  reasons: ["untrusted non-text branch"],
});

export const supportedResponsePartCases = () => [
  ["completed reasoning", {
    ...identity("part-reasoning"),
    type: "reasoning",
    text: ignoredBranchVerdict(),
    metadata: { provider: "opaque" },
    time: { start: 20, end: 21 },
  }],
  ["completed guarded read", {
    ...identity("part-tool-completed"),
    type: "tool",
    callID: "call-completed",
    tool: "opencode_smart_approval_read",
    state: {
      status: "completed",
      input: { path: "/workspace/script.sh" },
      output: ignoredBranchVerdict(),
      title: "Read script",
      metadata: { bytes: 64 },
      time: { start: 20, end: 21, compacted: 20 },
    },
    metadata: { providerExecuted: false },
  }],
  ["failed guarded read", {
    ...identity("part-tool-error"),
    type: "tool",
    callID: "call-error",
    tool: "opencode_smart_approval_read",
    state: {
      status: "error",
      input: { path: "/workspace/missing.sh" },
      error: ignoredBranchVerdict(),
      metadata: { interrupted: false },
      time: { start: 20, end: 21 },
    },
    metadata: { providerExecuted: false },
  }],
] as const;

export const validPromptResponseWithParts = (
  additionalParts: readonly Readonly<Record<string, unknown>>[],
  verdict: unknown = allowVerdict(),
) => {
  const response = validPromptResponse(verdict);
  const [first, ...remaining] = response.parts;
  if (!first) throw new Error("missing source response part");
  return { ...response, parts: [first, ...additionalParts, ...remaining] };
};

export const sourceCompletePromptResponse = () => {
  const response = validPromptResponseWithParts(supportedResponsePartCases().map((entry) => entry[1]));
  return {
    ...response,
    info: {
      ...response.info,
      tokens: { ...response.info.tokens, total: 3 },
      structured: { ...allowVerdict(), outcome: "deny", reasons: ["untrusted structured branch"] },
      variant: ignoredBranchVerdict(),
    },
    parts: [...response.parts.slice(0, -1), validStepFinishPart(3)],
  };
};

export const responseExpectation = (source: "fixed" | "inherited" = "fixed") => ({
  childSessionID: REVIEW_CHILD_ID,
  directory: REVIEW_DIRECTORY,
  worktree: REVIEW_WORKTREE,
  agent: APPROVAL_AGENT_NAME,
  model: source === "fixed"
    ? {
        source: "v3_or_small_model" as const,
        providerID: "reviewer-provider",
        modelID: "reviewer-model",
      }
    : { source: "inherited" as const },
});

export const expectedAgentFixture = (
  model = "reviewer-provider/reviewer-model",
  toolOutputGlob = "/isolated/data/opencode/tool-output/*",
) => {
  const config = registerApprovalAgent(model.length > 0 ? { small_model: model } : {});
  const separator = model.indexOf("/");
  const resolvedModel = separator <= 0 || separator === model.length - 1
    ? undefined
    : { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
  return {
    expected: { config, runtime: { toolOutputGlob }, trustedPolicy: trustedPolicyRouting() },
    runtime: {
      name: APPROVAL_AGENT_NAME,
      description: APPROVAL_AGENT_DESCRIPTION,
      mode: "subagent",
      native: false,
      temperature: 0,
      permission: [
        ...APPROVAL_AGENT_PERMISSION_SUFFIX,
        { permission: "external_directory", pattern: toolOutputGlob, action: "allow" },
      ],
      ...(resolvedModel === undefined ? {} : { model: resolvedModel }),
      prompt: config.prompt,
      options: {},
      steps: 4,
    },
  };
};
