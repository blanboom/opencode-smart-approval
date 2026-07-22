import type { TirithScan } from "./risk-tool";
import type { ReviewerTranscript } from "./transcript-types";
import type { CommandContext, RuleEvaluation, ShellAnalysis } from "./types";
import { projectReviewShellAnalysis, type ReviewShellAnalysis } from "./review-shell-dto";
import { stableJsonStringify, toStableJsonValue, type JsonValue } from "./stable-json";

export const MAX_REVIEW_REQUEST_UTF8_BYTES = 131_072;

export type SerializeReviewRequestInput = {
  readonly context: CommandContext;
  readonly shellAnalysis: ShellAnalysis;
  readonly evaluation: RuleEvaluation;
  readonly tirith: TirithScan;
  readonly transcript: ReviewerTranscript;
  readonly authorizationProof?: ReviewAuthorizationProof;
};

export type ReviewAuthorizationProof = {
  readonly status: "confirmed";
  readonly effect_sha256: string;
  readonly disclosure_sha256: string;
};

export type SerializedReviewRequest =
  | { readonly ok: true; readonly json: string }
  | { readonly ok: false; readonly code: "invalid_json" | "limit_exceeded" };

type ReviewRequestDto = {
  readonly schema_version: 1;
  readonly command: string;
  readonly cwd: string;
  readonly args: JsonValue;
  readonly shell_analysis: ReviewShellAnalysis;
  readonly rule_evaluation: {
    readonly categories: readonly { readonly id: string; readonly score: number }[];
    readonly reasons: readonly string[];
    readonly matched_labels: readonly string[];
  };
  readonly tirith: JsonValue;
  readonly transcript: JsonValue;
  readonly authorization_proof?: ReviewAuthorizationProof;
};

const tirithDto = (value: TirithScan): Record<string, unknown> => {
  const shared = {
    action: value.action,
    ...(value.freshness === undefined ? {} : { freshness: value.freshness }),
    ...(value.categories === undefined ? {} : { categories: value.categories }),
    ...(value.reasons === undefined ? {} : { reasons: value.reasons }),
  };
  return value.action === "allow"
    ? shared
    : {
        ...shared,
        risk_level: value.riskLevel,
        ...(value.action === "block" ? { source: value.source } : {}),
      };
};

export const serializeReviewRequest = (
  input: SerializeReviewRequestInput,
): SerializedReviewRequest => {
  const args = toStableJsonValue(input.context.args);
  const tirith = toStableJsonValue(tirithDto(input.tirith));
  const transcript = toStableJsonValue(input.transcript);
  if (!args.ok || !tirith.ok || !transcript.ok) return { ok: false, code: "invalid_json" };
  let shellAnalysis: ReviewShellAnalysis;
  try {
    shellAnalysis = projectReviewShellAnalysis(input.shellAnalysis);
  } catch (error) {
    if (error instanceof Error) return { ok: false, code: "invalid_json" };
    return { ok: false, code: "invalid_json" };
  }
  const dto: ReviewRequestDto = {
    schema_version: 1,
    command: input.context.command,
    cwd: input.context.cwd,
    args: args.value,
    shell_analysis: shellAnalysis,
    rule_evaluation: {
      categories: input.evaluation.categories.map((category) => ({ id: category.id, score: category.score })),
      reasons: [...input.evaluation.reasons],
      matched_labels: input.evaluation.matchedRules.map((rule) => rule.label),
    },
    tirith: tirith.value,
    transcript: transcript.value,
    ...(input.authorizationProof === undefined ? {} : { authorization_proof: input.authorizationProof }),
  };
  const serialized = stableJsonStringify(dto);
  if (!serialized.ok) return serialized;
  if (new TextEncoder().encode(serialized.value).byteLength > MAX_REVIEW_REQUEST_UTF8_BYTES) {
    return { ok: false, code: "limit_exceeded" };
  }
  return { ok: true, json: serialized.value };
};
