import { createMonotonicDeadline } from "../../src/bounded-race";
import type { OpenCodeCallResult } from "../../src/opencode-client-adapter";
import { reviewWithOpenCode } from "../../src/opencode-reviewer";
import type { SerializeReviewRequestInput } from "../../src/review-request";
import { expectedAgentFixture, validCreatedSession } from "./opencode-review-fixtures";
import { reviewRuntimeFixture } from "./opencode-review-runtime";

export type LifecycleOperation = () => Promise<OpenCodeCallResult>;

type PromptFailureFixtureInput = {
  readonly prompt: Promise<OpenCodeCallResult>;
  readonly abortOperation: LifecycleOperation;
  readonly observePrompt: () => void;
  readonly observeAbort: () => void;
};

const request: SerializeReviewRequestInput = {
  context: { sessionID: "parent-session", tool: "bash", command: "echo ok", cwd: "/workspace", args: {} },
  shellAnalysis: {
    source: "echo ok", segments: [], redirections: [], staticFileReferences: [], issues: [], nestedAnalyses: [],
  },
  evaluation: { decision: "review", matchedRules: [], categories: [], reasons: [] },
  tirith: { action: "allow" },
  transcript: { status: "disabled" },
};

export const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

export const startPromptFailure = (input: PromptFailureFixtureInput) => {
  const agent = expectedAgentFixture();
  let completedSetupCalls = 0;
  const fixture = reviewRuntimeFixture(async (method) => {
    if (method === "agents") {
      completedSetupCalls += 1;
      return { ok: true, data: [agent.runtime] };
    }
    if (method === "create") {
      completedSetupCalls += 1;
      return { ok: true, data: validCreatedSession() };
    }
    if (method === "prompt") { input.observePrompt(); return input.prompt; }
    if (method === "abort") { input.observeAbort(); return input.abortOperation(); }
    if (method === "delete") return { ok: true, data: true };
    return { ok: false, code: "sdk_error" };
  });
  const response = reviewWithOpenCode(fixture.runtime, {
    parentSessionID: "parent-session",
    deadline: createMonotonicDeadline(5_000, () => completedSetupCalls >= 3 ? 4_999 : 0),
    request,
  });
  return { fixture, response };
};
