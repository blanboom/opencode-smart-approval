import { isAbsolute } from "node:path";
import { z } from "zod";

const POLICY_KEYS = new Set([
  "version",
  "allow_local_config",
  "review",
  "self_protection",
  "tirith",
  "rules",
  "model",
  "timeout_ms",
  "context_messages",
  "prompt",
  "cleanup_session",
  "deny",
  "allow",
  "match",
  "reason",
  "scope",
  "priority",
  "enabled",
  "path",
  "fail_open",
] as const);

class UnsafePolicyInputError extends Error {
  readonly name = "UnsafePolicyInputError";
  constructor() {
    super("policy: unsafe object prototype");
  }
}

const assertOwnDataTree = (value: unknown, active: Set<object>): void => {
  if (typeof value !== "object" || value === null) return;
  if (active.has(value)) throw new UnsafePolicyInputError();
  const prototype: unknown = Object.getPrototypeOf(value);
  const expectedPrototype = Array.isArray(value) ? Array.prototype : Object.prototype;
  if (prototype !== expectedPrototype && prototype !== null) throw new UnsafePolicyInputError();
  active.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") continue;
      if (typeof key !== "string") throw new UnsafePolicyInputError();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new UnsafePolicyInputError();
      assertOwnDataTree(descriptor.value, active);
    }
  } finally {
    active.delete(value);
  }
};

const assertSafePolicyInput = (value: unknown): void => {
  for (const key of POLICY_KEYS) {
    if (Object.getOwnPropertyDescriptor(Object.prototype, key) !== undefined) throw new UnsafePolicyInputError();
  }
  assertOwnDataTree(value, new Set<object>());
};

const safeInteger = z.number().refine(Number.isSafeInteger, "must be a safe integer");
const exactTrimmedString = z.string().min(1).refine((value) => value.trim() === value, "must be exactly trimmed");

const ModelSchema = exactTrimmedString.regex(
  /^[^\s/]+\/\S+$/,
  "must be a provider/model identity without whitespace",
);

const ReviewSchema = z.strictObject({
  model: ModelSchema.optional(),
  timeout_ms: safeInteger.min(1_000).max(300_000).optional(),
  context_messages: safeInteger.min(0).max(200).optional(),
  prompt: exactTrimmedString.max(8_192).optional(),
  cleanup_session: z.boolean().optional(),
});

const RuleSchema = z.strictObject({
  match: z.string().min(1),
  reason: z.string().min(1).optional(),
  scope: z.enum(["command", "segment"]).optional(),
  priority: safeInteger.optional(),
});

const RulesSchema = z.strictObject({
  deny: z.array(RuleSchema).optional(),
  review: z.array(RuleSchema).optional(),
  allow: z.array(RuleSchema).optional(),
});

const TirithSchema = z.strictObject({
  enabled: z.boolean().optional(),
  path: exactTrimmedString.refine(isAbsolute, "must be an absolute path").optional(),
  timeout_ms: safeInteger.min(500).max(60_000).optional(),
  fail_open: z.boolean().optional(),
});

const SelfProtectionSchema = z.strictObject({
  enabled: z.boolean().optional(),
});

const PolicyV3Schema = z.strictObject({
  version: z.literal(3),
  allow_local_config: z.boolean().optional(),
  review: ReviewSchema,
  self_protection: SelfProtectionSchema.optional(),
  tirith: TirithSchema.optional(),
  rules: RulesSchema.optional(),
});

export type PolicyV3Document = z.infer<typeof PolicyV3Schema>;

const issueField = (issue: z.core.$ZodIssue): string => {
  const path = issue.path.map(String);
  if (issue.code === "unrecognized_keys") path.push(issue.keys[0] ?? "unknown");
  return path.length === 0 ? "policy" : path.join(".");
};

export const parsePolicyV3Document = (value: unknown): PolicyV3Document => {
  assertSafePolicyInput(value);
  const parsed = PolicyV3Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  if (!issue) throw new Error("policy: invalid policy document");
  throw new Error(`${issueField(issue)}: ${issue.message}`);
};
