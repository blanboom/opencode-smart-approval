import type { OpenCodeClientAdapter } from "./opencode-client-adapter";
import { projectCopiedAuthorizationEnvelope } from "./transcript-projector";
import type { AuthorizationSnapshot, TranscriptUnavailableReason } from "./transcript-types";

export const AUTHORIZATION_CONTEXT_LIMIT = 32;
export const AUTHORIZATION_CALL_TIMEOUT_MS = 2_000;

const unavailable = (reason: TranscriptUnavailableReason): AuthorizationSnapshot => Object.freeze({
  reviewer: Object.freeze({ status: "unavailable", reason }),
  entries: Object.freeze([]),
});

export const fetchAuthorizationContext = async (input: {
  readonly adapter: Pick<OpenCodeClientAdapter, "messages">;
  readonly parentSessionID: string;
  readonly canonicalDirectory: string;
  readonly signal: AbortSignal;
}): Promise<AuthorizationSnapshot> => {
  const result = await input.adapter.messages({
    sessionID: input.parentSessionID,
    directory: input.canonicalDirectory,
    limit: AUTHORIZATION_CONTEXT_LIMIT,
    signal: input.signal,
  });
  if (!result.ok) {
    if (input.signal.aborted) return unavailable("timeout");
    if (result.code === "limit_exceeded") return unavailable("limit_exceeded");
    if (result.code === "malformed_json") return unavailable("malformed");
    return unavailable("sdk_error");
  }
  return projectCopiedAuthorizationEnvelope({
    data: result.data,
    parentSessionID: input.parentSessionID,
    canonicalDirectory: input.canonicalDirectory,
    limit: AUTHORIZATION_CONTEXT_LIMIT,
  });
};
