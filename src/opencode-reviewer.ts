import type { ApprovalLeaseActivation, ApprovalLeaseHandle } from "./approval-reader";
import type { ReaderResult } from "./anchored-fs";
import type { ExpectedApprovalAgent } from "./approval-plugin-agent";
import type { MonotonicDeadline } from "./bounded-race";
import type { OpenCodeClientAdapter } from "./opencode-client-adapter";
import type { ReviewRegistry } from "./review-registry";
import type { SerializeReviewRequestInput } from "./review-request";
import type { ReviewResponse } from "./types";
import { APPROVAL_AGENT_NAME, APPROVAL_AGENT_PROMPT_TOOLS, validateResolvedApprovalAgent } from "./approval-agent";
import { expectedModelFromConfigured } from "./expected-model";
import { runBoundedCall, createMonotonicDeadline, type LateSettlement } from "./bounded-race";
import { createReviewHandle, type ReviewCleanupResult, type ReviewHandle } from "./review-handle";
import { serializeReviewRequest } from "./review-request";
import { validateCreatedReviewSession, type CreatedSessionExpectation } from "./review-session-schema";
import { ownedCreatedReviewSessionID } from "./review-session-ownership";
import { parseReviewPromptResponse } from "./review-response";
import type { OpenCodeCallResult } from "./opencode-client-adapter";

export const REVIEW_CHILD_TITLE = "opencode-smart-approval review";

export type OpenCodeReviewerRuntime = {
  readonly adapter: OpenCodeClientAdapter;
  readonly registry: ReviewRegistry;
  readonly projectID: string;
  readonly directory: string;
  readonly worktree: string;
  readonly expectedAgent: () => ExpectedApprovalAgent | undefined;
  readonly activate: (request: ApprovalLeaseActivation) => ReaderResult<ApprovalLeaseHandle>;
  readonly revoke: (handle: ApprovalLeaseHandle) => boolean;
};

export type OpenCodeReviewInput = {
  readonly parentSessionID: string;
  readonly deadline: MonotonicDeadline;
  readonly request: SerializeReviewRequestInput;
  readonly cleanupEnabled?: boolean;
};

type DataCallResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false };

export const failClosedOpenCodeReview = (code: string): ReviewResponse => ({
  outcome: "deny",
  riskLevel: "high",
  userAuthorization: "unknown",
  categories: [{ id: "security.reviewer_unavailable", score: 1 }],
  reasons: [`reviewer_failure:${code}`],
});

const withLifecycleResult = (
  response: ReviewResponse,
  cleanup: ReviewCleanupResult,
): ReviewResponse => cleanup.ok ? response : {
  outcome: "deny",
  riskLevel: response.riskLevel === "critical" ? "critical" : "high",
  userAuthorization: response.userAuthorization,
  categories: [
    ...response.categories,
    ...response.categories.some((category) => category.id === "security.reviewer_lifecycle")
      ? []
      : [{ id: "security.reviewer_lifecycle", score: 1 }],
  ],
  reasons: [...response.reasons, `reviewer_lifecycle:${cleanup.code}`],
};

const remaining = (deadline: MonotonicDeadline): number => Math.max(0, deadline.expiresAt - deadline.now());

const dataCall = async (
  deadline: MonotonicDeadline,
  operation: (signal: AbortSignal) => Promise<OpenCodeCallResult>,
): Promise<DataCallResult> => {
  const result = await runBoundedCall({ deadline, timeoutMs: remaining(deadline), operation });
  return result.ok && result.value.ok
    ? { ok: true, data: result.value.data }
    : { ok: false };
};

const agentMatches = (
  data: unknown,
  expected: ExpectedApprovalAgent,
): boolean => {
  try {
    validateResolvedApprovalAgent(data, expected.config, expected.runtime);
    return true;
  } catch (error) {
    if (error instanceof Error) return false;
    return false;
  }
};

const handleFor = (
  runtime: OpenCodeReviewerRuntime,
  childID: string,
  cleanupEnabled: boolean,
): ReviewHandle => createReviewHandle({
  childID,
  directory: runtime.directory,
  cleanupEnabled,
  revoke: runtime.revoke,
  abort: (signal) => runtime.adapter.abort({ sessionID: childID, directory: runtime.directory, signal }),
  delete: (signal) => runtime.adapter.delete({ sessionID: childID, directory: runtime.directory, signal }),
});

const registerHandle = (
  runtime: OpenCodeReviewerRuntime,
  childID: string,
  cleanupEnabled: boolean,
): ReviewHandle | undefined => {
  const handle = handleFor(runtime, childID, cleanupEnabled);
  if (runtime.registry.add(handle)) return handle;
  return undefined;
};

const logLateCleanup = async (
  runtime: OpenCodeReviewerRuntime,
  childID: string,
  cleanup: ReviewCleanupResult,
): Promise<void> => {
  const deadline = createMonotonicDeadline(1_000);
  await runBoundedCall({
    deadline,
    timeoutMs: 1_000,
    operation: (signal) => runtime.adapter.log({
      directory: runtime.directory,
      service: "opencode-smart-approval",
      level: "warn",
      message: "review.late_create_cleanup",
      extra: { event: "late_create", child_id: childID, result: cleanup.ok ? "success" : cleanup.failure },
      signal,
    }),
  });
};

const cleanupLateCreate = async (
  runtime: OpenCodeReviewerRuntime,
  settlement: LateSettlement<OpenCodeCallResult>,
  expectation: CreatedSessionExpectation,
): Promise<void> => {
  if (settlement.status !== "fulfilled" || !settlement.value.ok) return;
  const childID = ownedCreatedReviewSessionID(settlement.value.data, expectation);
  if (!childID) return;
  const handle = registerHandle(runtime, childID, true);
  if (!handle) return;
  const cleanup = await handle.cleanup(true);
  await logLateCleanup(runtime, childID, cleanup);
};

const validateAgents = async (
  runtime: OpenCodeReviewerRuntime,
  deadline: MonotonicDeadline,
  expected: ExpectedApprovalAgent,
): Promise<boolean> => {
  const agents = await dataCall(deadline, (signal) => runtime.adapter.agents({
    directory: runtime.directory,
    signal,
  }));
  return agents.ok && agentMatches(agents.data, expected);
};

const cleanupFailure = async (
  handle: ReviewHandle,
  primary: ReviewResponse,
): Promise<ReviewResponse> => withLifecycleResult(primary, await handle.cleanup(true));

export const reviewWithOpenCode = async (
  runtime: OpenCodeReviewerRuntime,
  input: OpenCodeReviewInput,
): Promise<ReviewResponse> => {
  const serialized = serializeReviewRequest(input.request);
  if (!serialized.ok) return failClosedOpenCodeReview(serialized.code);
  const expected = runtime.expectedAgent();
  if (!expected) return failClosedOpenCodeReview("agent_unavailable");
  const model = expectedModelFromConfigured(expected.config.model);
  if (!model.ok) return failClosedOpenCodeReview(model.code);
  if (!await validateAgents(runtime, input.deadline, expected)) return failClosedOpenCodeReview("agent_mismatch");

  const createExpectation = {
    projectID: runtime.projectID,
    directory: runtime.directory,
    parentID: input.parentSessionID,
    title: REVIEW_CHILD_TITLE,
  };
  const created = await runBoundedCall({
    deadline: input.deadline,
    timeoutMs: remaining(input.deadline),
    operation: (signal) => runtime.adapter.create({
      parentID: input.parentSessionID,
      title: REVIEW_CHILD_TITLE,
      directory: runtime.directory,
      signal,
    }),
    onLateSettlement: (settlement) => cleanupLateCreate(runtime, settlement, createExpectation),
  });
  if (!created.ok || !created.value.ok) return failClosedOpenCodeReview("create_failed");
  const validated = validateCreatedReviewSession(created.value.data, createExpectation);
  const childID = ownedCreatedReviewSessionID(created.value.data, createExpectation);
  if (!childID) return failClosedOpenCodeReview("invalid_session");
  const handle = registerHandle(runtime, childID, input.cleanupEnabled ?? true);
  if (!handle) return failClosedOpenCodeReview("ownership_failed");
  if (!validated.ok) return cleanupFailure(handle, failClosedOpenCodeReview(validated.code));

  const activation = runtime.activate({
    sessionID: childID,
    agent: APPROVAL_AGENT_NAME,
    directory: runtime.directory,
    references: input.request.shellAnalysis.staticFileReferences,
  });
  if (!activation.ok || !handle.activate(activation.value)) {
    if (activation.ok) runtime.revoke(activation.value);
    return cleanupFailure(handle, failClosedOpenCodeReview("lease_failed"));
  }
  if (!await validateAgents(runtime, input.deadline, expected)) {
    return cleanupFailure(handle, failClosedOpenCodeReview("agent_mismatch"));
  }

  const prompt = await runBoundedCall({
    deadline: input.deadline,
    timeoutMs: remaining(input.deadline),
    operation: (signal) => {
      const settlement = runtime.adapter.prompt({
        sessionID: childID,
        directory: runtime.directory,
        agent: APPROVAL_AGENT_NAME,
        tools: APPROVAL_AGENT_PROMPT_TOOLS,
        text: serialized.json,
        signal,
      });
      handle.setPromptSettlement(settlement);
      return settlement;
    },
  });
  if (!prompt.ok || !prompt.value.ok) return cleanupFailure(handle, failClosedOpenCodeReview("prompt_failed"));
  handle.settlePrompt();
  const parsed = parseReviewPromptResponse(prompt.value.data, {
    childSessionID: childID,
    directory: runtime.directory,
    worktree: runtime.worktree,
    agent: APPROVAL_AGENT_NAME,
    model: model.value,
  });
  if (!parsed.ok) return cleanupFailure(handle, failClosedOpenCodeReview(parsed.code));
  return withLifecycleResult(parsed.value, await handle.cleanup(false));
};
