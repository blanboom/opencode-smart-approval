import { TranscriptEnvelopeSchema, type ParsedTranscriptEntry, type ParsedTranscriptPart } from "./transcript-schema";
import {
  MAX_TRANSCRIPT_ENVELOPE_UTF8_BYTES,
  MAX_TRANSCRIPT_PARTS_PER_MESSAGE,
  MAX_TRANSCRIPT_TEXT_CHARS_PER_PART,
  MAX_TRANSCRIPT_TOOL_NAME_CHARS,
  MAX_TRANSCRIPT_TOTAL_CHARS,
  MAX_TRANSCRIPT_TOTAL_PARTS,
  emptyTranscriptSnapshot,
  type AuthorizationEntry,
  type AuthorizationMessage,
  type AuthorizationSnapshot,
  type ReviewerTranscript,
  type ReviewerTranscriptMessage,
  type ReviewerTranscriptPart,
  type TranscriptSnapshot,
  type TranscriptUnavailableReason,
} from "./transcript-types";
import { hasOnlyAutomaticEmptyDiffSummary, isMessageSummary } from "./transcript-summary";
const AUTHORIZATION_PHRASE = /AUTHORIZE opencode-smart-approval [A-Za-z0-9_-]{43}/gu;
const REDACTED_AUTHORIZATION_PHRASE = "[authorization phrase redacted]";
const SOURCE_MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const redactAuthorizationPhrases = (text: string): string =>
  text.replace(AUTHORIZATION_PHRASE, REDACTED_AUTHORIZATION_PHRASE);
export const redactReviewerTranscript = (transcript: ReviewerTranscript): ReviewerTranscript => {
  if (transcript.status !== "available") return Object.freeze(transcript);
  return Object.freeze({
    status: "available",
    messages: Object.freeze(transcript.messages.map((message) => Object.freeze({
      role: message.role,
      parts: Object.freeze(message.parts.map((part) => part.type === "text"
        ? Object.freeze({ type: "text", text: redactAuthorizationPhrases(part.text) })
        : Object.freeze({ type: "tool", name: part.name, status: part.status }))),
    }))),
  });
};
export type TranscriptProjectionInput = {
  readonly data: unknown;
  readonly parentSessionID: string;
  readonly canonicalDirectory: string;
  readonly limit: number;
};
export type BoundedTranscriptJsonCopy =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: "malformed" | "limit_exceeded" };
const unavailable = (reason: TranscriptUnavailableReason): TranscriptSnapshot =>
  emptyTranscriptSnapshot({ status: "unavailable", reason });

const isOrdinaryText = (
  part: ParsedTranscriptPart,
): part is Extract<ParsedTranscriptPart, { readonly type: "text" }> =>
  part.type === "text" && part.synthetic !== true && part.ignored !== true;

const identityFailure = (
  entries: readonly ParsedTranscriptEntry[],
  parentSessionID: string,
  canonicalDirectory: string,
): "identity_mismatch" | "order_mismatch" | undefined => {
  const messageIDs = new Set<string>();
  const partIDs = new Set<string>();
  let previous: { readonly created: number; readonly id: string } | undefined;
  for (const entry of entries) {
    if (!SOURCE_MESSAGE_ID.test(entry.info.id) || entry.info.sessionID !== parentSessionID) return "identity_mismatch";
    if (messageIDs.has(entry.info.id)) return "order_mismatch";
    if (
      previous
      && (entry.info.time.created < previous.created
        || (entry.info.time.created === previous.created && entry.info.id <= previous.id))
    ) return "order_mismatch";
    if (entry.info.role === "assistant" && entry.info.path.cwd !== canonicalDirectory) return "identity_mismatch";
    messageIDs.add(entry.info.id);
    previous = { created: entry.info.time.created, id: entry.info.id };
    for (const part of entry.parts) {
      const attachedParts = part.type === "tool" && part.state.status === "completed"
        ? part.state.attachments ?? []
        : [];
      for (const identifiedPart of [part, ...attachedParts]) {
        if (
          identifiedPart.sessionID !== parentSessionID ||
          identifiedPart.messageID !== entry.info.id ||
          partIDs.has(identifiedPart.id)
        ) return "identity_mismatch";
        partIDs.add(identifiedPart.id);
      }
    }
  }
  return undefined;
};

const authorizationMessage = (
  entry: ParsedTranscriptEntry,
  responsePosition: number,
): AuthorizationMessage | undefined => {
  if (
    entry.info.role !== "user" ||
    (entry.info.summary !== undefined && !hasOnlyAutomaticEmptyDiffSummary(entry)) ||
    entry.info.system !== undefined ||
    entry.parts.length !== 1
  ) return undefined;
  const part = entry.parts[0];
  if (!part || !isOrdinaryText(part)) return undefined;
  return Object.freeze({
    messageID: entry.info.id,
    sessionID: entry.info.sessionID,
    created: entry.info.time.created,
    responsePosition,
    text: part.text,
  });
};

const projectedParts = (
  entry: ParsedTranscriptEntry,
): { readonly parts: readonly ReviewerTranscriptPart[]; readonly characters: number } | TranscriptUnavailableReason => {
  if (isMessageSummary(entry)) return { parts: Object.freeze([]), characters: 0 };
  const parts: ReviewerTranscriptPart[] = [];
  let characters = 0;
  for (const part of entry.parts) {
    if (isOrdinaryText(part)) {
      if (part.text.length > MAX_TRANSCRIPT_TEXT_CHARS_PER_PART) return "limit_exceeded";
      characters += part.text.length;
      parts.push(Object.freeze({
        type: "text",
        text: redactAuthorizationPhrases(part.text),
      }));
      continue;
    }
    if (part.type === "tool") {
      if (part.tool.length > MAX_TRANSCRIPT_TOOL_NAME_CHARS) return "limit_exceeded";
      characters += part.tool.length + part.state.status.length;
      parts.push(Object.freeze({ type: "tool", name: part.tool, status: part.state.status }));
    }
  }
  return { parts: Object.freeze(parts), characters };
};

const immutableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableJsonValue));
  if (typeof value !== "object" || value === null) return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [key, immutableJsonValue(nestedValue)]),
  ));
};

export const copyBoundedTranscriptJson = (value: unknown): BoundedTranscriptJsonCopy => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    if (error instanceof Error) return { ok: false, reason: "malformed" };
    return { ok: false, reason: "malformed" };
  }
  if (serialized === undefined) return { ok: false, reason: "malformed" };
  if (new TextEncoder().encode(serialized).byteLength > MAX_TRANSCRIPT_ENVELOPE_UTF8_BYTES) {
    return { ok: false, reason: "limit_exceeded" };
  }
  try {
    return { ok: true, value: immutableJsonValue(JSON.parse(serialized)) };
  } catch (error) {
    if (error instanceof Error) return { ok: false, reason: "malformed" };
    return { ok: false, reason: "malformed" };
  }
};

export const projectCopiedTranscriptEnvelope = (input: TranscriptProjectionInput): TranscriptSnapshot => {
  const parsed = TranscriptEnvelopeSchema.safeParse(input.data);
  if (!parsed.success) return unavailable("malformed");
  if (parsed.data.length > input.limit) return unavailable("limit_exceeded");
  const failure = identityFailure(parsed.data, input.parentSessionID, input.canonicalDirectory);
  if (failure) return unavailable(failure);

  const messages: ReviewerTranscriptMessage[] = [];
  const authorizationMessages: AuthorizationMessage[] = [];
  let totalParts = 0;
  let totalCharacters = 0;
  for (const [responsePosition, entry] of parsed.data.entries()) {
    totalParts += entry.parts.length;
    if (entry.parts.length > MAX_TRANSCRIPT_PARTS_PER_MESSAGE || totalParts > MAX_TRANSCRIPT_TOTAL_PARTS) {
      return unavailable("limit_exceeded");
    }
    const projected = projectedParts(entry);
    if (typeof projected === "string") return unavailable(projected);
    totalCharacters += projected.characters;
    if (totalCharacters > MAX_TRANSCRIPT_TOTAL_CHARS) return unavailable("limit_exceeded");
    if (projected.parts.length > 0) {
      messages.push(Object.freeze({ role: entry.info.role, parts: projected.parts }));
    }
    const authorization = authorizationMessage(entry, responsePosition);
    if (authorization) authorizationMessages.push(authorization);
  }

  return Object.freeze({
    reviewer: Object.freeze({ status: "available", messages: Object.freeze(messages) }),
    authorizationMessages: Object.freeze(authorizationMessages),
  });
};

const unavailableAuthorization = (reason: TranscriptUnavailableReason): AuthorizationSnapshot => Object.freeze({
  reviewer: Object.freeze({ status: "unavailable", reason }),
  entries: Object.freeze([]),
});

export const projectCopiedAuthorizationEnvelope = (input: TranscriptProjectionInput): AuthorizationSnapshot => {
  const transcript = projectCopiedTranscriptEnvelope(input);
  if (transcript.reviewer.status !== "available") {
    return Object.freeze({ reviewer: transcript.reviewer, entries: Object.freeze([]) });
  }
  const parsed = TranscriptEnvelopeSchema.safeParse(input.data);
  if (!parsed.success) return unavailableAuthorization("malformed");
  const entries: AuthorizationEntry[] = [];
  let reviewerPosition = 0;
  for (const [responsePosition, entry] of parsed.data.entries()) {
    const projected = projectedParts(entry);
    if (typeof projected === "string") return unavailableAuthorization(projected);
    const position = projected.parts.length > 0 ? reviewerPosition : undefined;
    if (position !== undefined) reviewerPosition += 1;
    const authorization = authorizationMessage(entry, responsePosition);
    entries.push(authorization && position !== undefined
      ? Object.freeze({
          kind: "eligible_user",
          messageID: authorization.messageID,
          created: authorization.created,
          responsePosition,
          reviewerPosition: position,
          text: authorization.text,
        })
      : Object.freeze({
          kind: entry.info.role === "user" ? "ineligible_user" : "assistant",
          messageID: entry.info.id,
          created: entry.info.time.created,
          responsePosition,
        }));
  }
  return Object.freeze({ reviewer: transcript.reviewer, entries: Object.freeze(entries) });
};

export const projectTranscriptEnvelope = (input: TranscriptProjectionInput): TranscriptSnapshot => {
  const copied = copyBoundedTranscriptJson(input.data);
  if (!copied.ok) return unavailable(copied.reason);
  return projectCopiedTranscriptEnvelope({ ...input, data: copied.value });
};

export const projectAuthorizationEnvelope = (input: TranscriptProjectionInput): AuthorizationSnapshot => {
  const copied = copyBoundedTranscriptJson(input.data);
  if (!copied.ok) return unavailableAuthorization(copied.reason);
  return projectCopiedAuthorizationEnvelope({ ...input, data: copied.value });
};
