export const MAX_TRANSCRIPT_ENVELOPE_UTF8_BYTES = 262_144;
export const MAX_TRANSCRIPT_TEXT_CHARS_PER_PART = 2_000;
export const MAX_TRANSCRIPT_TOTAL_CHARS = 20_000;
export const MAX_TRANSCRIPT_PARTS_PER_MESSAGE = 32;
export const MAX_TRANSCRIPT_TOTAL_PARTS = 256;
export const MAX_TRANSCRIPT_TOOL_NAME_CHARS = 128;

export type TranscriptUnavailableReason =
  | "timeout"
  | "sdk_error"
  | "identity_mismatch"
  | "order_mismatch"
  | "malformed"
  | "limit_exceeded";

export type ReviewerTranscriptPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool";
      readonly name: string;
      readonly status: "completed" | "error" | "pending" | "running";
    };

export type ReviewerTranscriptMessage = {
  readonly role: "user" | "assistant";
  readonly parts: readonly ReviewerTranscriptPart[];
};

export type ReviewerTranscript =
  | { readonly status: "available"; readonly messages: readonly ReviewerTranscriptMessage[] }
  | { readonly status: "disabled" }
  | { readonly status: "unavailable"; readonly reason: TranscriptUnavailableReason };

export type AuthorizationMessage = {
  readonly messageID: string;
  readonly sessionID: string;
  readonly created: number;
  readonly responsePosition: number;
  readonly text: string;
};

type AuthorizationEntryIdentity = {
  readonly messageID: string;
  readonly created: number;
  readonly responsePosition: number;
};

export type AuthorizationEntry = AuthorizationEntryIdentity & (
  | { readonly kind: "eligible_user"; readonly reviewerPosition: number; readonly text: string }
  | { readonly kind: "ineligible_user" }
  | { readonly kind: "assistant" }
);

export type AuthorizationSnapshot = {
  readonly reviewer: ReviewerTranscript;
  readonly entries: readonly AuthorizationEntry[];
};

export type TranscriptSnapshot = {
  readonly reviewer: ReviewerTranscript;
  readonly authorizationMessages: readonly AuthorizationMessage[];
};

export type SessionMessagesRequest = {
  readonly path: { readonly id: string };
  readonly query: { readonly directory: string; readonly limit: number };
  readonly signal: AbortSignal;
};

export type SessionMessagesClient = {
  readonly session: {
    readonly messages: (options: SessionMessagesRequest) => Promise<unknown>;
  };
};

export type TranscriptFetchInput = {
  readonly client: SessionMessagesClient | undefined;
  readonly parentSessionID: string;
  readonly canonicalDirectory: string;
  readonly limit: number;
  readonly signal: AbortSignal;
};

export const emptyTranscriptSnapshot = (
  reviewer: Exclude<ReviewerTranscript, { readonly status: "available" }>,
): TranscriptSnapshot => Object.freeze({
  reviewer: Object.freeze(reviewer),
  authorizationMessages: Object.freeze([]),
});
