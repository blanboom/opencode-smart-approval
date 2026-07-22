import type { ExpectedModel } from "./expected-model";
import type { ReviewResponse } from "./types";
import { expectedModelMatches } from "./expected-model";
import {
  ReviewPromptEnvelopeSchema,
  StrictVerdictSchema,
  type ParsedReviewEnvelope,
} from "./review-response-schema";
import { parseUniqueJson } from "./unique-json";

export const MAX_REVIEW_RESPONSE_PARTS = 64;
export const MAX_REVIEW_RESPONSE_ORDINARY_TEXT_UTF8_BYTES = 32_768;
export const MAX_REVIEW_RESPONSE_ENVELOPE_UTF8_BYTES = 131_072;

export type ReviewResponseExpectation = {
  readonly childSessionID: string;
  readonly directory: string;
  readonly worktree: string;
  readonly agent: string;
  readonly model: ExpectedModel;
};

export type ParsedReviewResponse =
  | { readonly ok: true; readonly value: ReviewResponse }
  | {
      readonly ok: false;
      readonly code: "malformed_envelope" | "limit_exceeded" | "identity_mismatch" | "invalid_verdict";
    };

const copiedEnvelope = (input: unknown): ParsedReviewResponse | { readonly ok: true; readonly value: unknown } => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch (error) {
    if (error instanceof Error) return { ok: false, code: "malformed_envelope" };
    return { ok: false, code: "malformed_envelope" };
  }
  if (serialized === undefined) return { ok: false, code: "malformed_envelope" };
  if (new TextEncoder().encode(serialized).byteLength > MAX_REVIEW_RESPONSE_ENVELOPE_UTF8_BYTES) {
    return { ok: false, code: "limit_exceeded" };
  }
  try {
    return { ok: true, value: JSON.parse(serialized) };
  } catch (error) {
    if (error instanceof Error) return { ok: false, code: "malformed_envelope" };
    return { ok: false, code: "malformed_envelope" };
  }
};

const partCount = (input: unknown): number | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const parts = Reflect.get(input, "parts");
  return Array.isArray(parts) ? parts.length : undefined;
};

const identitiesMatch = (value: ParsedReviewEnvelope, expected: ReviewResponseExpectation): boolean => {
  const info = value.info;
  if (
    info.sessionID !== expected.childSessionID ||
    info.parentID === info.id ||
    info.agent !== expected.agent ||
    info.mode !== expected.agent ||
    info.path.cwd !== expected.directory ||
    info.path.root !== expected.worktree ||
    info.time.completed < info.time.created ||
    !expectedModelMatches(expected.model, { providerID: info.providerID, modelID: info.modelID }, true)
  ) return false;
  const ids = new Set<string>();
  for (const part of value.parts) {
    if (
      part.sessionID !== expected.childSessionID ||
      part.messageID !== info.id ||
      ids.has(part.id)
    ) return false;
    ids.add(part.id);
  }
  return true;
};

type VerdictTextResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: "limit_exceeded" | "invalid_verdict" };

const verdictText = (value: ParsedReviewEnvelope): VerdictTextResult => {
  const texts: string[] = [];
  for (const part of value.parts) {
    if (part.type === "text" && part.synthetic !== true && part.ignored !== true) texts.push(part.text);
  }
  const ordinary = texts.join("");
  if (new TextEncoder().encode(ordinary).byteLength > MAX_REVIEW_RESPONSE_ORDINARY_TEXT_UTF8_BYTES) {
    return { ok: false, code: "limit_exceeded" };
  }
  const trimmed = ordinary.trim();
  return trimmed.length === 0
    ? { ok: false, code: "invalid_verdict" }
    : { ok: true, text: trimmed };
};

export const parseReviewPromptResponse = (
  input: unknown,
  expected: ReviewResponseExpectation,
): ParsedReviewResponse => {
  const copied = copiedEnvelope(input);
  if (!copied.ok) return copied;
  const count = partCount(copied.value);
  if (count !== undefined && count > MAX_REVIEW_RESPONSE_PARTS) return { ok: false, code: "limit_exceeded" };
  const parsed = ReviewPromptEnvelopeSchema.safeParse(copied.value);
  if (!parsed.success) return { ok: false, code: "malformed_envelope" };
  if (!identitiesMatch(parsed.data, expected)) return { ok: false, code: "identity_mismatch" };
  const text = verdictText(parsed.data);
  if (!text.ok) return text;
  const verdictInput = parseUniqueJson(text.text);
  if (!verdictInput.ok) return { ok: false, code: "invalid_verdict" };
  const verdict = StrictVerdictSchema.safeParse(verdictInput.value);
  if (!verdict.success) return { ok: false, code: "invalid_verdict" };
  const evidence = {
    riskLevel: verdict.data.risk_level,
    userAuthorization: verdict.data.user_authorization,
    categories: verdict.data.categories,
    reasons: verdict.data.reasons,
  };
  return verdict.data.outcome === "needs_confirmation" ? {
    ok: true,
    value: {
      outcome: verdict.data.outcome,
      ...evidence,
      confirmation: verdict.data.confirmation,
    },
  } : {
    ok: true,
    value: { outcome: verdict.data.outcome, ...evidence },
  };
};
