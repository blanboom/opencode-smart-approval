import { createHash, randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";
import { AUTHORIZATION_CALL_TIMEOUT_MS, fetchAuthorizationContext } from "./authorization-context";
import { runBoundedCall, type MonotonicDeadline } from "./bounded-race";
import type { CommandEffectResult } from "./command-effect";
import { createConfirmationDisclosure } from "./confirmation-disclosure";
import { createConfirmationLedger, type PendingConfirmation } from "./confirmation-ledger";
import { redactKnownConfirmationTokens } from "./confirmation-redaction";
import type { OpenCodeClientAdapter } from "./opencode-client-adapter";
import type { ReviewAuthorizationProof } from "./review-request";
import type { ReviewerTranscript } from "./transcript-types";
import type { ApprovalVerdict, ReviewResponse } from "./types";
import {
  renderCommandApprovalError,
  renderConfirmationBody,
  type CommandApprovalError,
  type ConfirmationChallenge,
} from "./user-facing";
export const CONFIRMATION_TTL_MS = 5 * 60 * 1_000;
const TOKEN_PATTERN = /^AUTHORIZE opencode-smart-approval ([A-Za-z0-9_-]{43})$/u;
const PREFLIGHT_TOKEN = "A".repeat(43);
type Effect = Extract<CommandEffectResult, { readonly ok: true }>;
type ConfirmationReview = Extract<ReviewResponse, { readonly outcome: "needs_confirmation" }>;
export type ConfirmationCheckResult =
  | { readonly kind: "none" }
  | { readonly kind: "awaiting" }
  | { readonly kind: "unavailable"; readonly code: "timeout" | "sdk_error" | "malformed" }
  | { readonly kind: "rejected"; readonly code: string }
  | { readonly kind: "confirmed"; readonly proof: ReviewAuthorizationProof; readonly transcript: ReviewerTranscript };
export type ConfirmationIssueResult =
  | { readonly kind: "error"; readonly error: CommandApprovalError }
  | { readonly kind: "failure"; readonly code: string };
export type ConfirmationService = {
  issue(input: { readonly effect: Effect; readonly review: ConfirmationReview; readonly tool: string; readonly deadline: MonotonicDeadline }): Promise<ConfirmationIssueResult>;
  check(input: { readonly effect: Effect; readonly deadline: MonotonicDeadline }): Promise<ConfirmationCheckResult>;
  redact(parentSessionID: string, transcript: ReviewerTranscript): ReviewerTranscript;
  clearSession(parentSessionID: string): Promise<void>;
  dispose(): Promise<void>;
};
const confirmationVerdict = (review: ConfirmationReview): ApprovalVerdict => ({
  decision: "block",
  source: "review",
  reasonSource: "reviewer",
  riskLevel: review.riskLevel,
  userAuthorization: review.userAuthorization,
  categories: review.categories.some((category) => category.id === "security.explicit_confirmation_required")
    ? review.categories
    : [...review.categories, { id: "security.explicit_confirmation_required", score: 1 }],
  reasons: review.reasons,
  matchedRuleLabels: [],
});
const tokenDigest = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();
const confirmedTranscript = (transcript: ReviewerTranscript, reviewerPosition: number): ReviewerTranscript => {
  if (transcript.status !== "available") return transcript;
  return Object.freeze({
    status: "available",
    messages: Object.freeze(transcript.messages.map((message, index) => index === reviewerPosition
      ? Object.freeze({
          role: "user",
          parts: Object.freeze([{ type: "text", text: "[explicit authorization confirmed by plugin]" }] as const),
        })
      : message)),
  });
};
export const createConfirmationService = (input: {
  readonly adapter: Pick<OpenCodeClientAdapter, "messages">;
  readonly directory: string;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly now?: () => number;
}): ConfirmationService => {
  const ledger = createConfirmationLedger();
  const generate = input.randomBytes ?? cryptoRandomBytes;
  const currentTime = input.now ?? (() => performance.now());
  let disposed = false;
  const fetchAuthorization = async (parentSessionID: string, deadline: MonotonicDeadline) => {
    const call = await runBoundedCall({
      deadline,
      timeoutMs: AUTHORIZATION_CALL_TIMEOUT_MS,
      operation: (signal) => fetchAuthorizationContext({
        adapter: input.adapter,
        parentSessionID,
        canonicalDirectory: input.directory,
        signal,
      }),
    });
    return call.ok
      ? call.value
      : {
          reviewer: { status: "unavailable", reason: call.code === "rejected" ? "sdk_error" : "timeout" } as const,
          entries: [] as const,
        };
  };

  const issue: ConfirmationService["issue"] = async ({ effect, review, tool, deadline }) => ledger.runLocked(
    effect.effect.parentSessionID,
    async () => {
      if (disposed) return { kind: "failure", code: "confirmation_disposed" };
      const now = deadline.now();
      const existing = ledger.pending(effect.effect.parentSessionID);
      if (existing && existing.expiresAt <= now) ledger.deletePending(effect.effect.parentSessionID);
      const replaced = ledger.pending(effect.effect.parentSessionID) !== undefined;
      const values = { command: effect.effect.command, cwd: effect.effect.canonicalCwd, ...review.confirmation };
      const disclosure = createConfirmationDisclosure(values);
      if (!disclosure.ok) return { kind: "failure", code: "confirmation_render_failed" };
      const scaffold: ConfirmationChallenge = {
        values,
        effectSha256: effect.sha256,
        disclosureSha256: disclosure.sha256,
        token: PREFLIGHT_TOKEN,
        replaced,
      };
      if (!renderConfirmationBody(scaffold).ok) return { kind: "failure", code: "confirmation_render_failed" };
      const boundary = await fetchAuthorization(effect.effect.parentSessionID, deadline);
      if (boundary.reviewer.status !== "available" || boundary.entries.length === 0) {
        return { kind: "failure", code: "authorization_boundary_unavailable" };
      }
      const finalEntry = boundary.entries.at(-1);
      if (!finalEntry) return { kind: "failure", code: "authorization_boundary_unavailable" };
      let generated: Uint8Array;
      try {
        generated = generate(32);
      } catch (error) {
        if (error instanceof Error) return { kind: "failure", code: "confirmation_rng_failed" };
        return { kind: "failure", code: "confirmation_rng_failed" };
      }
      if (generated.byteLength !== 32) return { kind: "failure", code: "confirmation_rng_failed" };
      const token = Buffer.from(generated).toString("base64url");
      const challenge = { ...scaffold, token };
      const rendered = renderCommandApprovalError({
        kind: "confirmation",
        tool,
        verdict: confirmationVerdict(review),
        challenge,
      });
      if (rendered.kind !== "error") return { kind: "failure", code: rendered.code };
      const hash = tokenDigest(token);
      const pending: PendingConfirmation = {
        parentSessionID: effect.effect.parentSessionID,
        canonicalCwd: effect.effect.canonicalCwd,
        effectSha256: effect.sha256,
        disclosureSha256: disclosure.sha256,
        tokenHash: hash,
        generation: ledger.nextGeneration(effect.effect.parentSessionID),
        boundary: { messageID: finalEntry.messageID, created: finalEntry.created },
        issuedAt: now,
        expiresAt: now + CONFIRMATION_TTL_MS,
      };
      ledger.remember(effect.effect.parentSessionID, hash, now);
      ledger.setPending(pending);
      return { kind: "error", error: rendered.error };
    },
  );

  const check: ConfirmationService["check"] = async ({ effect, deadline }) => ledger.runLocked(
    effect.effect.parentSessionID,
    async () => {
      if (disposed) return { kind: "rejected", code: "confirmation_disposed" };
      const pending = ledger.pending(effect.effect.parentSessionID);
      if (!pending) return { kind: "none" };
      const now = deadline.now();
      if (pending.expiresAt <= now) {
        ledger.deletePending(effect.effect.parentSessionID);
        return { kind: "rejected", code: "expired" };
      }
      if (
        pending.effectSha256 !== effect.sha256
        || pending.parentSessionID !== effect.effect.parentSessionID
        || pending.canonicalCwd !== effect.effect.canonicalCwd
      ) return { kind: "none" };
      const snapshot = await fetchAuthorization(effect.effect.parentSessionID, deadline);
      if (snapshot.reviewer.status !== "available") {
        const reason = snapshot.reviewer.status === "unavailable" ? snapshot.reviewer.reason : "malformed";
        if (reason === "timeout" || reason === "sdk_error" || reason === "malformed") {
          return { kind: "unavailable", code: reason };
        }
        ledger.deletePending(effect.effect.parentSessionID);
        return { kind: "rejected", code: reason };
      }
      const boundaryPosition = snapshot.entries.findIndex((entry) => entry.messageID === pending.boundary.messageID);
      const boundary = boundaryPosition < 0 ? undefined : snapshot.entries[boundaryPosition];
      if (!boundary || boundary.created !== pending.boundary.created) {
        ledger.deletePending(effect.effect.parentSessionID);
        return { kind: "rejected", code: "boundary_mismatch" };
      }
      const suffix = snapshot.entries.slice(boundaryPosition + 1);
      const eligible = suffix.filter((entry) => entry.kind === "eligible_user");
      if (suffix.some((entry) => entry.kind === "ineligible_user")) {
        ledger.deletePending(effect.effect.parentSessionID);
        return { kind: "rejected", code: "invalid_user_message" };
      }
      if (eligible.length === 0) return { kind: "awaiting" };
      const authorization = eligible[0];
      if (eligible.length !== 1 || !authorization) {
        ledger.deletePending(effect.effect.parentSessionID);
        return { kind: "rejected", code: "ambiguous_suffix" };
      }
      const phrase = TOKEN_PATTERN.exec(authorization.text);
      if (!phrase) {
        ledger.deletePending(effect.effect.parentSessionID);
        return { kind: "rejected", code: "phrase_mismatch" };
      }
      const supplied = phrase[1];
      if (!supplied) {
        ledger.deletePending(effect.effect.parentSessionID);
        return { kind: "rejected", code: "phrase_mismatch" };
      }
      const consumeTime = deadline.now();
      if (pending.expiresAt <= consumeTime) {
        ledger.deletePending(effect.effect.parentSessionID);
        return { kind: "rejected", code: "expired" };
      }
      const suppliedHash = tokenDigest(supplied);
      const matches = suppliedHash.byteLength === pending.tokenHash.byteLength
        && timingSafeEqual(suppliedHash, pending.tokenHash);
      suppliedHash.fill(0);
      if (!matches) {
        ledger.deletePending(effect.effect.parentSessionID);
        return { kind: "rejected", code: "token_mismatch" };
      }
      const proof: ReviewAuthorizationProof = {
        status: "confirmed",
        effect_sha256: pending.effectSha256,
        disclosure_sha256: pending.disclosureSha256,
      };
      ledger.deletePending(effect.effect.parentSessionID);
      const redacted = redactKnownConfirmationTokens(
        snapshot.reviewer,
        ledger.hashes(effect.effect.parentSessionID, consumeTime),
      );
      return {
        kind: "confirmed",
        proof,
        transcript: confirmedTranscript(redacted, authorization.reviewerPosition),
      };
    },
  );

  return Object.freeze({
    issue,
    check,
    redact: (parentSessionID, transcript) => redactKnownConfirmationTokens(
      transcript,
      ledger.hashes(parentSessionID, currentTime()),
    ),
    clearSession: (parentSessionID) => ledger.runLocked(parentSessionID, async () => ledger.clearSession(parentSessionID)),
    dispose: async () => {
      disposed = true;
      await ledger.dispose();
    },
  });
};
