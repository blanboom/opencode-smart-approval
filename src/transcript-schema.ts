import { z } from "zod";

const IdentitySchema = z.string().min(1);
const FiniteTimeSchema = z.number().finite();
const TimeCreatedSchema = z.looseObject({ created: FiniteTimeSchema });
const ModelSchema = z.looseObject({ providerID: IdentitySchema, modelID: IdentitySchema });
const RecordSchema = z.record(z.string(), z.unknown());
const FileDiffSchema = z.looseObject({
  file: z.string(),
  before: z.string(),
  after: z.string(),
  additions: FiniteTimeSchema,
  deletions: FiniteTimeSchema,
});
const TokensSchema = z.looseObject({
  input: FiniteTimeSchema,
  output: FiniteTimeSchema,
  reasoning: FiniteTimeSchema,
  cache: z.looseObject({ read: FiniteTimeSchema, write: FiniteTimeSchema }),
});
const ApiErrorSchema = z.looseObject({
  name: z.literal("APIError"),
  data: z.looseObject({
    message: z.string(),
    statusCode: FiniteTimeSchema.optional(),
    isRetryable: z.boolean(),
    responseHeaders: z.record(z.string(), z.string()).optional(),
    responseBody: z.string().optional(),
  }),
});
const AssistantErrorSchema = z.discriminatedUnion("name", [
  z.looseObject({
    name: z.literal("ProviderAuthError"),
    data: z.looseObject({ providerID: IdentitySchema, message: z.string() }),
  }),
  z.looseObject({ name: z.literal("UnknownError"), data: z.looseObject({ message: z.string() }) }),
  z.looseObject({ name: z.literal("MessageOutputLengthError"), data: RecordSchema }),
  z.looseObject({ name: z.literal("MessageAbortedError"), data: z.looseObject({ message: z.string() }) }),
  ApiErrorSchema,
]);

const UserInfoSchema = z.looseObject({
  id: IdentitySchema,
  sessionID: IdentitySchema,
  role: z.literal("user"),
  time: TimeCreatedSchema,
  summary: z.looseObject({
    title: z.string().optional(),
    body: z.string().optional(),
    diffs: z.array(FileDiffSchema),
  }).optional(),
  agent: IdentitySchema,
  model: ModelSchema,
  system: z.string().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
});

const AssistantInfoSchema = z.looseObject({
  id: IdentitySchema,
  sessionID: IdentitySchema,
  role: z.literal("assistant"),
  time: z.looseObject({ created: FiniteTimeSchema, completed: FiniteTimeSchema.optional() }),
  error: AssistantErrorSchema.optional(),
  parentID: IdentitySchema,
  modelID: IdentitySchema,
  providerID: IdentitySchema,
  mode: IdentitySchema,
  path: z.looseObject({ cwd: z.string(), root: z.string() }),
  summary: z.boolean().optional(),
  cost: FiniteTimeSchema,
  tokens: TokensSchema,
  finish: z.string().optional(),
});

const PartIdentityShape = {
  id: IdentitySchema,
  sessionID: IdentitySchema,
  messageID: IdentitySchema,
} as const;

const TextPartSchema = z.looseObject({
  ...PartIdentityShape,
  type: z.literal("text"),
  text: z.string(),
  synthetic: z.boolean().optional(),
  ignored: z.boolean().optional(),
  time: z.looseObject({ start: FiniteTimeSchema, end: FiniteTimeSchema.optional() }).optional(),
  metadata: RecordSchema.optional(),
});

const FileTextSourceSchema = z.looseObject({
  value: z.string(),
  start: FiniteTimeSchema,
  end: FiniteTimeSchema,
});
const FileSourceSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("file"), text: FileTextSourceSchema, path: z.string() }),
  z.looseObject({
    type: z.literal("symbol"),
    text: FileTextSourceSchema,
    path: z.string(),
    range: z.looseObject({
      start: z.looseObject({ line: FiniteTimeSchema, character: FiniteTimeSchema }),
      end: z.looseObject({ line: FiniteTimeSchema, character: FiniteTimeSchema }),
    }),
    name: z.string(),
    kind: FiniteTimeSchema,
  }),
]);
const FilePartSchema = z.looseObject({
  ...PartIdentityShape,
  type: z.literal("file"),
  mime: z.string(),
  filename: z.string().optional(),
  url: z.string(),
  source: FileSourceSchema.optional(),
});

const ToolStateSchema = z.discriminatedUnion("status", [
  z.looseObject({
    status: z.literal("pending"),
    input: RecordSchema,
    raw: z.string(),
  }),
  z.looseObject({
    status: z.literal("running"),
    input: RecordSchema,
    title: z.string().optional(),
    metadata: RecordSchema.optional(),
    time: z.looseObject({ start: FiniteTimeSchema }),
  }),
  z.looseObject({
    status: z.literal("completed"),
    input: RecordSchema,
    output: z.string(),
    title: z.string(),
    metadata: RecordSchema,
    time: z.looseObject({
      start: FiniteTimeSchema,
      end: FiniteTimeSchema,
      compacted: FiniteTimeSchema.optional(),
    }),
    attachments: z.array(FilePartSchema).optional(),
  }),
  z.looseObject({
    status: z.literal("error"),
    input: RecordSchema,
    error: z.string(),
    metadata: RecordSchema.optional(),
    time: z.looseObject({ start: FiniteTimeSchema, end: FiniteTimeSchema }),
  }),
]);

const ToolPartSchema = z.looseObject({
  ...PartIdentityShape,
  type: z.literal("tool"),
  callID: IdentitySchema,
  tool: z.string(),
  state: ToolStateSchema,
  metadata: RecordSchema.optional(),
});

const ExcludedPartSchema = z.discriminatedUnion("type", [
  z.looseObject({
    ...PartIdentityShape,
    type: z.literal("subtask"),
    prompt: z.string(),
    description: z.string(),
    agent: z.string(),
  }),
  z.looseObject({
    ...PartIdentityShape,
    type: z.literal("reasoning"),
    text: z.string(),
    metadata: RecordSchema.optional(),
    time: z.looseObject({ start: FiniteTimeSchema, end: FiniteTimeSchema.optional() }),
  }),
  FilePartSchema,
  z.looseObject({ ...PartIdentityShape, type: z.literal("step-start"), snapshot: z.string().optional() }),
  z.looseObject({
    ...PartIdentityShape,
    type: z.literal("step-finish"),
    reason: z.string(),
    snapshot: z.string().optional(),
    cost: FiniteTimeSchema,
    tokens: TokensSchema,
  }),
  z.looseObject({ ...PartIdentityShape, type: z.literal("snapshot"), snapshot: z.string() }),
  z.looseObject({
    ...PartIdentityShape,
    type: z.literal("patch"),
    hash: z.string(),
    files: z.array(z.string()),
  }),
  z.looseObject({
    ...PartIdentityShape,
    type: z.literal("agent"),
    name: z.string(),
    source: z.looseObject({ value: z.string(), start: FiniteTimeSchema, end: FiniteTimeSchema }).optional(),
  }),
  z.looseObject({
    ...PartIdentityShape,
    type: z.literal("retry"),
    attempt: FiniteTimeSchema,
    error: ApiErrorSchema,
    time: TimeCreatedSchema,
  }),
  z.looseObject({ ...PartIdentityShape, type: z.literal("compaction"), auto: z.boolean() }),
]);

export const TranscriptEnvelopeSchema = z.array(z.strictObject({
  info: z.discriminatedUnion("role", [UserInfoSchema, AssistantInfoSchema]),
  parts: z.array(z.union([TextPartSchema, ToolPartSchema, ExcludedPartSchema])),
}));

export const SessionMessagesResultSchema = z.looseObject({
  data: z.unknown().optional(),
  error: z.unknown().optional(),
});

export type ParsedTranscriptEntry = z.infer<typeof TranscriptEnvelopeSchema>[number];
export type ParsedTranscriptPart = ParsedTranscriptEntry["parts"][number];
