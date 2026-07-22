import { SessionMessagesResultSchema } from "./transcript-schema";
import {
  copyBoundedTranscriptJson,
  projectCopiedTranscriptEnvelope,
} from "./transcript-projector";
import {
  emptyTranscriptSnapshot,
  type TranscriptFetchInput,
  type TranscriptSnapshot,
} from "./transcript-types";
import type { OpenCodeClientAdapter } from "./opencode-client-adapter";

export type {
  AuthorizationEntry,
  AuthorizationMessage,
  AuthorizationSnapshot,
  ReviewerTranscript,
  ReviewerTranscriptMessage,
  ReviewerTranscriptPart,
  TranscriptFetchInput,
  TranscriptSnapshot,
  TranscriptUnavailableReason,
} from "./transcript-types";
export {
  MAX_TRANSCRIPT_ENVELOPE_UTF8_BYTES,
  MAX_TRANSCRIPT_PARTS_PER_MESSAGE,
  MAX_TRANSCRIPT_TEXT_CHARS_PER_PART,
  MAX_TRANSCRIPT_TOOL_NAME_CHARS,
  MAX_TRANSCRIPT_TOTAL_CHARS,
  MAX_TRANSCRIPT_TOTAL_PARTS,
} from "./transcript-types";
export {
  projectAuthorizationEnvelope,
  projectTranscriptEnvelope,
  redactReviewerTranscript,
  type TranscriptProjectionInput,
} from "./transcript-projector";

const disabled = (): TranscriptSnapshot => emptyTranscriptSnapshot({ status: "disabled" });
const unavailable = (reason: "timeout" | "sdk_error" | "malformed" | "limit_exceeded"): TranscriptSnapshot =>
  emptyTranscriptSnapshot({ status: "unavailable", reason });

export const fetchSessionContext = async (input: TranscriptFetchInput): Promise<TranscriptSnapshot> => {
  if (!input.client || input.limit <= 0) return disabled();
  if (!Number.isSafeInteger(input.limit)) return unavailable("limit_exceeded");
  if (input.signal.aborted) return unavailable("timeout");

  let response: unknown;
  try {
    response = await input.client.session.messages({
      path: { id: input.parentSessionID },
      query: { directory: input.canonicalDirectory, limit: input.limit },
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal.aborted || (error instanceof Error && error.name === "TimeoutError")) {
      return unavailable("timeout");
    }
    if (error instanceof Error) return unavailable("sdk_error");
    return unavailable("sdk_error");
  }

  const copied = copyBoundedTranscriptJson(response);
  if (!copied.ok) return unavailable(copied.reason);
  const result = SessionMessagesResultSchema.safeParse(copied.value);
  if (!result.success) return unavailable("malformed");
  if (result.data.error !== undefined) return unavailable("sdk_error");
  if (result.data.data === undefined) return unavailable("malformed");
  return projectCopiedTranscriptEnvelope({
    data: result.data.data,
    parentSessionID: input.parentSessionID,
    canonicalDirectory: input.canonicalDirectory,
    limit: input.limit,
  });
};

export type AdapterTranscriptFetchInput = Omit<TranscriptFetchInput, "client"> & {
  readonly adapter: Pick<OpenCodeClientAdapter, "messages"> | undefined;
};

export const fetchSessionContextWithAdapter = async (
  input: AdapterTranscriptFetchInput,
): Promise<TranscriptSnapshot> => {
  if (!input.adapter || input.limit <= 0) return disabled();
  if (!Number.isSafeInteger(input.limit)) return unavailable("limit_exceeded");
  if (input.signal.aborted) return unavailable("timeout");
  const result = await input.adapter.messages({
    sessionID: input.parentSessionID,
    directory: input.canonicalDirectory,
    limit: input.limit,
    signal: input.signal,
  });
  if (!result.ok) {
    if (input.signal.aborted) return unavailable("timeout");
    if (result.code === "limit_exceeded") return unavailable("limit_exceeded");
    if (result.code === "malformed_json") return unavailable("malformed");
    return unavailable("sdk_error");
  }
  return projectCopiedTranscriptEnvelope({
    data: result.data,
    parentSessionID: input.parentSessionID,
    canonicalDirectory: input.canonicalDirectory,
    limit: input.limit,
  });
};
