import { z } from "zod";

export type CreatedSessionExpectation = {
  readonly projectID: string;
  readonly directory: string;
  readonly parentID: string;
  readonly title: string;
};

export type CreatedSessionValidation =
  | { readonly ok: true; readonly childID: string }
  | { readonly ok: false; readonly code: "invalid_session"; readonly cleanableID?: string };

const FiniteNumberSchema = z.number().finite();
const NonNegativeIntegerSchema = FiniteNumberSchema.int().nonnegative();

const FileDiffSchema = z.strictObject({
  file: z.string().optional(),
  patch: z.string().optional(),
  additions: FiniteNumberSchema,
  deletions: FiniteNumberSchema,
  status: z.enum(["added", "deleted", "modified"]).optional(),
});

const SessionSummarySchema = z.strictObject({
  additions: FiniteNumberSchema,
  deletions: FiniteNumberSchema,
  files: FiniteNumberSchema,
  diffs: z.array(FileDiffSchema).optional(),
});

const SessionTokensSchema = z.strictObject({
  input: FiniteNumberSchema,
  output: FiniteNumberSchema,
  reasoning: FiniteNumberSchema,
  cache: z.strictObject({
    read: FiniteNumberSchema,
    write: FiniteNumberSchema,
  }),
});

const SessionTimeSchema = z.strictObject({
  created: NonNegativeIntegerSchema,
  updated: NonNegativeIntegerSchema,
  compacting: NonNegativeIntegerSchema.optional(),
  archived: FiniteNumberSchema.optional(),
});

const PermissionRuleSchema = z.strictObject({
  permission: z.string(),
  pattern: z.string(),
  action: z.enum(["allow", "deny", "ask"]),
});

const CreatedSessionSchema = z.strictObject({
  id: z.string().min(1),
  slug: z.string(),
  projectID: z.string().min(1),
  workspaceID: z.string().startsWith("wrk").optional(),
  directory: z.string().min(1),
  path: z.string().optional(),
  parentID: z.string().min(1),
  summary: SessionSummarySchema.optional(),
  cost: FiniteNumberSchema.optional(),
  tokens: SessionTokensSchema.optional(),
  share: z.strictObject({ url: z.string() }).optional(),
  title: z.string().min(1),
  agent: z.string().optional(),
  model: z.strictObject({
    id: z.string(),
    providerID: z.string(),
    variant: z.string().optional(),
  }).optional(),
  version: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  time: SessionTimeSchema,
  permission: z.array(PermissionRuleSchema).optional(),
  revert: z.strictObject({
    messageID: z.string().startsWith("msg"),
    partID: z.string().startsWith("prt").optional(),
    snapshot: z.string().optional(),
    diff: z.string().optional(),
  }).optional(),
});

const cleanableID = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(input, "id");
  return descriptor && "value" in descriptor && typeof descriptor.value === "string" && descriptor.value.length > 0
    ? descriptor.value
    : undefined;
};

export const validateCreatedReviewSession = (
  input: unknown,
  expected: CreatedSessionExpectation,
): CreatedSessionValidation => {
  const ownedID = cleanableID(input);
  const failure = (): CreatedSessionValidation => ownedID === undefined
    ? { ok: false, code: "invalid_session" }
    : { ok: false, code: "invalid_session", cleanableID: ownedID };
  const parsed = CreatedSessionSchema.safeParse(input);
  if (!parsed.success) return failure();
  const session = parsed.data;
  if (
    session.projectID !== expected.projectID ||
    session.directory !== expected.directory ||
    session.parentID !== expected.parentID ||
    session.title !== expected.title ||
    session.time.updated < session.time.created
  ) return failure();
  return { ok: true, childID: session.id };
};
