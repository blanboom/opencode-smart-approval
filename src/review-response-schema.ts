import { z } from "zod";
import { isValidCategoryId } from "./category-id";

export const MAX_REVIEW_CATEGORIES = 32;
export const MAX_REVIEW_REASONS = 16;
export const MAX_REVIEW_REASON_UTF8_BYTES = 1_024;
export const MAX_REVIEW_REASONS_TOTAL_UTF8_BYTES = 8_192;
export const MAX_CONFIRMATION_FIELD_UTF8_BYTES = 1_024;
export const MAX_CONFIRMATION_TOTAL_UTF8_BYTES = 4_096;

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

const hasValidUnicodeScalars = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const asciiLowercase = (value: string): string => value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());

const COMMON_PLACEHOLDERS = new Set([
  "unknown", "n/a", "na", "none", "null", "unspecified", "not specified", "tbd",
  "to be determined", "placeholder", "?", "-", "...",
]);

const FIELD_PLACEHOLDERS = {
  action: new Set(["action", "do it", "do something", "perform action"]),
  data: new Set(["data", "some data", "user data", "information", "something"]),
  destination: new Set(["destination", "somewhere", "remote", "external", "external service", "internet"]),
  risk: new Set(["risk", "some risk", "unknown risk", "may be risky", "potential risk"]),
} as const;

const concreteConfirmationField = (field: keyof typeof FIELD_PLACEHOLDERS) => z.string().refine((value) => {
  const key = asciiLowercase(value);
  return hasValidUnicodeScalars(value)
    && value.length > 0
    && value === value.trim()
    && byteLength(value) <= MAX_CONFIRMATION_FIELD_UTF8_BYTES
    && /[\p{L}\p{N}]/u.test(value)
    && !COMMON_PLACEHOLDERS.has(key)
    && !FIELD_PLACEHOLDERS[field].has(key);
});

const ConfirmationSchema = z.strictObject({
  action: concreteConfirmationField("action"),
  data: concreteConfirmationField("data"),
  destination: concreteConfirmationField("destination"),
  risk: concreteConfirmationField("risk"),
}).refine((confirmation) => Object.values(confirmation).reduce(
  (total, value) => total + byteLength(value),
  0,
) <= MAX_CONFIRMATION_TOTAL_UTF8_BYTES);

const CategorySchema = z.strictObject({
  id: z.string().refine(isValidCategoryId),
  score: z.number().finite().min(0).max(1),
});

const CategoriesSchema = z.array(CategorySchema).min(1).max(MAX_REVIEW_CATEGORIES).refine(
  (categories) => new Set(categories.map((category) => category.id)).size === categories.length,
);

const ReasonSchema = z.string().refine((value) => (
  hasValidUnicodeScalars(value)
  && value.trim().length > 0
  && byteLength(value) <= MAX_REVIEW_REASON_UTF8_BYTES
));

const ReasonsSchema = z.array(ReasonSchema).min(1).max(MAX_REVIEW_REASONS).refine(
  (reasons) => reasons.reduce((total, reason) => total + byteLength(reason), 0) <= MAX_REVIEW_REASONS_TOTAL_UTF8_BYTES,
);

const FiniteNonnegativeSchema = z.number().finite().nonnegative();
const IdentitySchema = z.string().min(1);
const TimeRangeSchema = z.strictObject({
  start: z.number().finite(),
  end: z.number().finite(),
});
const TokensSchema = z.strictObject({
  total: FiniteNonnegativeSchema.optional(),
  input: FiniteNonnegativeSchema,
  output: FiniteNonnegativeSchema,
  reasoning: FiniteNonnegativeSchema,
  cache: z.strictObject({
    read: FiniteNonnegativeSchema,
    write: FiniteNonnegativeSchema,
  }),
});
const PartIdentityShape = {
  id: IdentitySchema,
  sessionID: IdentitySchema,
  messageID: IdentitySchema,
};

const TextPartSchema = z.strictObject({
  ...PartIdentityShape,
  type: z.literal("text"),
  text: z.string(),
  synthetic: z.boolean().optional(),
  ignored: z.boolean().optional(),
  time: z.strictObject({ start: z.number().finite(), end: z.number().finite().optional() }).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const ReasoningPartSchema = z.strictObject({
  ...PartIdentityShape,
  type: z.literal("reasoning"),
  text: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  time: TimeRangeSchema,
});
const StepStartPartSchema = z.strictObject({
  ...PartIdentityShape,
  type: z.literal("step-start"),
  snapshot: z.string().optional(),
});
const StepFinishPartSchema = z.strictObject({
  ...PartIdentityShape,
  type: z.literal("step-finish"),
  reason: z.string(),
  snapshot: z.string().optional(),
  cost: FiniteNonnegativeSchema,
  tokens: TokensSchema,
});
const CompletedToolStateSchema = z.strictObject({
  status: z.literal("completed"),
  input: z.record(z.string(), z.unknown()),
  output: z.string(),
  title: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  time: z.strictObject({
    start: z.number().finite(),
    end: z.number().finite(),
    compacted: z.number().finite().optional(),
  }),
});
const ErrorToolStateSchema = z.strictObject({
  status: z.literal("error"),
  input: z.record(z.string(), z.unknown()),
  error: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  time: TimeRangeSchema,
});
const ToolPartSchema = z.strictObject({
  ...PartIdentityShape,
  type: z.literal("tool"),
  callID: IdentitySchema,
  tool: z.literal("opencode_smart_approval_read"),
  state: z.discriminatedUnion("status", [CompletedToolStateSchema, ErrorToolStateSchema]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ReviewPartSchema = z.discriminatedUnion("type", [
  TextPartSchema,
  ReasoningPartSchema,
  StepStartPartSchema,
  StepFinishPartSchema,
  ToolPartSchema,
]);

export const ReviewAssistantSchema = z.strictObject({
  id: IdentitySchema,
  sessionID: IdentitySchema,
  role: z.literal("assistant"),
  time: z.strictObject({ created: z.number().finite(), completed: z.number().finite() }),
  parentID: IdentitySchema,
  modelID: IdentitySchema,
  providerID: IdentitySchema,
  agent: IdentitySchema,
  mode: IdentitySchema,
  path: z.strictObject({ cwd: IdentitySchema, root: IdentitySchema }),
  summary: z.boolean().optional(),
  cost: FiniteNonnegativeSchema,
  tokens: TokensSchema,
  structured: z.json().optional(),
  variant: z.string().optional(),
  finish: z.literal("stop"),
});

export const ReviewPromptEnvelopeSchema = z.strictObject({
  info: ReviewAssistantSchema,
  parts: z.array(ReviewPartSchema),
});

const VerdictEvidenceShape = {
  risk_level: z.enum(["low", "medium", "high", "critical"]),
  user_authorization: z.enum(["unknown", "low", "medium", "high"]),
  categories: CategoriesSchema,
  reasons: ReasonsSchema,
} as const;

export const StrictVerdictSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("allow"), ...VerdictEvidenceShape }),
  z.strictObject({ outcome: z.literal("deny"), ...VerdictEvidenceShape }),
  z.strictObject({
    outcome: z.literal("needs_confirmation"),
    ...VerdictEvidenceShape,
    confirmation: ConfirmationSchema,
  }),
]);

export type ParsedReviewEnvelope = z.infer<typeof ReviewPromptEnvelopeSchema>;
