import type { ApprovalLeaseActivation, ApprovalLeaseHandle } from "../../src/approval-reader";
import type { OpenCodeCallResult, OpenCodeClientAdapter } from "../../src/opencode-client-adapter";
import type { OpenCodeReviewerRuntime } from "../../src/opencode-reviewer";
import { createReviewRegistry } from "../../src/review-registry";
import { expectedAgentFixture } from "./opencode-review-fixtures";

type AdapterMethod = keyof OpenCodeClientAdapter;
type AdapterRun = (method: AdapterMethod, input: unknown) => Promise<OpenCodeCallResult>;

type ReviewRuntimeRoots = {
  readonly directory?: string;
  readonly worktree?: string;
};

export type ReviewRuntimeFixture = {
  readonly runtime: OpenCodeReviewerRuntime;
  readonly calls: readonly { readonly method: AdapterMethod; readonly input: unknown }[];
  readonly activations: readonly ApprovalLeaseActivation[];
  readonly revocations: readonly ApprovalLeaseHandle[];
};

export const reviewRuntimeFixture = (run: AdapterRun, roots: ReviewRuntimeRoots = {}): ReviewRuntimeFixture => {
  const calls: { method: AdapterMethod; input: unknown }[] = [];
  const invoke = (method: AdapterMethod, input: unknown): Promise<OpenCodeCallResult> => {
    calls.push({ method, input });
    return run(method, input);
  };
  const adapter: OpenCodeClientAdapter = {
    agents: (input) => invoke("agents", input),
    messages: (input) => invoke("messages", input),
    create: (input) => invoke("create", input),
    prompt: (input) => invoke("prompt", input),
    abort: (input) => invoke("abort", input),
    delete: (input) => invoke("delete", input),
    log: (input) => invoke("log", input),
  };
  const activations: ApprovalLeaseActivation[] = [];
  const revocations: ApprovalLeaseHandle[] = [];
  const agent = expectedAgentFixture();
  return {
    runtime: {
      adapter,
      registry: createReviewRegistry(),
      projectID: "project-id",
      directory: roots.directory ?? "/workspace",
      worktree: roots.worktree ?? roots.directory ?? "/workspace",
      expectedAgent: () => agent.expected,
      activate: (request) => {
        activations.push(request);
        return { ok: true, value: { sessionID: request.sessionID, generation: activations.length } };
      },
      revoke: (handle) => { revocations.push(handle); return true; },
    },
    calls,
    activations,
    revocations,
  };
};
