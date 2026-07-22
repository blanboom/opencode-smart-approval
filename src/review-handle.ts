import type { ApprovalLeaseHandle } from "./approval-reader";
import type { OpenCodeCallResult } from "./opencode-client-adapter";
import { createMonotonicDeadline, runBoundedCall } from "./bounded-race";
import { APPROVAL_AGENT_NAME } from "./approval-agent-contract";

export const CLEANUP_CALL_TIMEOUT_MS = 2_000;
export const PROMPT_DRAIN_TIMEOUT_MS = 5_000;

export type ReviewHandleState =
  | "owned_inactive"
  | "active"
  | "inactive"
  | "retained"
  | "cleanup_requested"
  | "deleted"
  | "cleanup_failed";

export type ReviewCleanupResult =
  | { readonly ok: true; readonly code: "retained" | "deleted" | "already_deleted" }
  | {
      readonly ok: false;
      readonly code: "abort_failed" | "drain_failed" | "delete_failed";
      readonly failure: "timeout" | "error";
    };

export type ReviewHandleSnapshot = {
  readonly state: ReviewHandleState;
  readonly promptSettled: boolean;
  readonly externalDeletedObserved: boolean;
  readonly hasLease: boolean;
  readonly hasCleanupPromise: boolean;
  readonly hasPromptSettlement: boolean;
  readonly hasTerminalListener: boolean;
};

export type ReviewHandleInput = {
  readonly childID: string;
  readonly directory: string;
  readonly cleanupEnabled: boolean;
  readonly revoke: (lease: ApprovalLeaseHandle) => boolean;
  readonly abort: (signal: AbortSignal) => Promise<OpenCodeCallResult>;
  readonly delete: (signal: AbortSignal) => Promise<OpenCodeCallResult>;
};

export interface ReviewHandle {
  readonly childID: string;
  readonly agentType: typeof APPROVAL_AGENT_NAME;
  readonly directory: string;
  readonly cleanupEnabled: boolean;
  activate(lease: ApprovalLeaseHandle): boolean;
  setPromptSettlement(settlement: Promise<unknown>): boolean;
  settlePrompt(): boolean;
  observeDeleted(): boolean;
  onTerminal(listener: () => void): boolean;
  cleanup(abnormal: boolean): Promise<ReviewCleanupResult>;
  snapshot(): ReviewHandleSnapshot;
}

type CleanupCallResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: "timeout" | "error" };

const failedCall = (code: "exhausted" | "timeout" | "rejected"): CleanupCallResult => ({
  ok: false,
  failure: code === "exhausted" || code === "timeout" ? "timeout" : "error",
});

const callResult = async (
  operation: (signal: AbortSignal) => Promise<OpenCodeCallResult>,
): Promise<CleanupCallResult> => {
  const result = await runBoundedCall({
    deadline: createMonotonicDeadline(CLEANUP_CALL_TIMEOUT_MS),
    timeoutMs: CLEANUP_CALL_TIMEOUT_MS,
    operation,
  });
  if (!result.ok) return failedCall(result.code);
  return result.value.ok && result.value.data === true
    ? { ok: true }
    : { ok: false, failure: "error" };
};

class OwnedReviewHandle implements ReviewHandle {
  readonly childID: string;
  readonly agentType = APPROVAL_AGENT_NAME;
  readonly directory: string;
  readonly cleanupEnabled: boolean;
  private state: ReviewHandleState = "owned_inactive";
  private promptSettled = false;
  private externalDeletedObserved = false;
  private lease: ApprovalLeaseHandle | undefined;
  private promptSettlement: Promise<unknown> | undefined;
  private cleanupPromise: Promise<ReviewCleanupResult> | undefined;
  private terminalListener: (() => void) | undefined;

  constructor(private readonly input: ReviewHandleInput) {
    this.childID = input.childID;
    this.directory = input.directory;
    this.cleanupEnabled = input.cleanupEnabled;
  }

  activate(lease: ApprovalLeaseHandle): boolean {
    if (
      this.state !== "owned_inactive" ||
      lease.sessionID !== this.childID ||
      this.lease !== undefined
    ) return false;
    this.lease = lease;
    this.state = "active";
    return true;
  }

  setPromptSettlement(settlement: Promise<unknown>): boolean {
    if (this.state !== "active" || this.promptSettlement !== undefined) return false;
    this.promptSettlement = settlement;
    return true;
  }

  settlePrompt(): boolean {
    if (this.state !== "active") return false;
    this.promptSettled = true;
    this.promptSettlement = undefined;
    this.revokeLease();
    this.state = "inactive";
    return true;
  }

  observeDeleted(): boolean {
    if (this.terminal()) return false;
    this.externalDeletedObserved = true;
    this.revokeLease();
    this.finishTerminal("deleted");
    return true;
  }

  onTerminal(listener: () => void): boolean {
    if (this.terminal() || this.terminalListener !== undefined) return false;
    this.terminalListener = listener;
    return true;
  }

  cleanup(abnormal: boolean): Promise<ReviewCleanupResult> {
    if (this.cleanupPromise) return this.cleanupPromise;
    if (this.state === "deleted") return Promise.resolve({ ok: true, code: "already_deleted" });
    if (this.state === "retained") return Promise.resolve({ ok: true, code: "retained" });
    if (!abnormal && !this.cleanupEnabled && this.state !== "cleanup_failed") {
      if (this.state === "active") this.settlePrompt();
      this.cleanupPromise = Promise.resolve({ ok: true, code: "retained" });
      this.finishTerminal("retained");
      return this.cleanupPromise;
    }
    const shouldAbort = this.state === "active" && !this.promptSettled && this.promptSettlement !== undefined;
    this.revokeLease();
    this.state = "cleanup_requested";
    const shared = this.runCleanup(shouldAbort);
    this.cleanupPromise = shared;
    return shared;
  }

  snapshot(): ReviewHandleSnapshot {
    return {
      state: this.state,
      promptSettled: this.promptSettled,
      externalDeletedObserved: this.externalDeletedObserved,
      hasLease: this.lease !== undefined,
      hasCleanupPromise: this.cleanupPromise !== undefined,
      hasPromptSettlement: this.promptSettlement !== undefined,
      hasTerminalListener: this.terminalListener !== undefined,
    };
  }

  private async runCleanup(shouldAbort: boolean): Promise<ReviewCleanupResult> {
    const result = await this.performCleanup(shouldAbort);
    if (!this.terminal()) this.cleanupPromise = undefined;
    return result;
  }

  private async performCleanup(shouldAbort: boolean): Promise<ReviewCleanupResult> {
    let failure: ReviewCleanupResult | undefined;
    if (shouldAbort) {
      const aborted = await callResult(this.input.abort);
      if (!aborted.ok) failure = { ok: false, code: "abort_failed", failure: aborted.failure };
      if (aborted.ok) {
        const drained = await this.drainPrompt();
        if (!drained.ok) failure = { ok: false, code: "drain_failed", failure: drained.failure };
      }
    }
    this.promptSettlement = undefined;
    const deleted = await callResult(this.input.delete);
    const externallyDeleted = this.externalDeletedObserved;
    if (deleted.ok || externallyDeleted) {
      this.finishTerminal("deleted");
      if (failure) return failure;
      return externallyDeleted
        ? { ok: true, code: "already_deleted" }
        : { ok: true, code: "deleted" };
    }
    this.state = "cleanup_failed";
    return failure ?? { ok: false, code: "delete_failed", failure: deleted.failure };
  }

  private async drainPrompt(): Promise<CleanupCallResult> {
    if (!this.promptSettlement) return { ok: false, failure: "error" };
    const result = await runBoundedCall({
      deadline: createMonotonicDeadline(PROMPT_DRAIN_TIMEOUT_MS),
      timeoutMs: PROMPT_DRAIN_TIMEOUT_MS,
      operation: async () => this.promptSettlement,
    });
    if (!result.ok) return failedCall(result.code);
    this.promptSettled = true;
    return { ok: true };
  }

  private revokeLease(): void {
    const current = this.lease;
    this.lease = undefined;
    if (current) this.input.revoke(current);
  }

  private finishTerminal(state: "deleted" | "retained"): void {
    this.state = state;
    this.promptSettlement = undefined;
    const listener = this.terminalListener;
    this.terminalListener = undefined;
    listener?.();
  }

  private terminal(): boolean {
    return this.state === "deleted" || this.state === "retained";
  }
}

export const createReviewHandle = (input: ReviewHandleInput): ReviewHandle => new OwnedReviewHandle(input);
