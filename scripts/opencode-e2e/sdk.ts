import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { HarnessContractError } from "./errors";

const EnvelopeSchema = z.object({ data: z.unknown().optional(), error: z.unknown().optional() }).passthrough();
const SessionIdSchema = z.object({ id: z.string().regex(/^ses_[A-Za-z0-9_-]+$/u) }).passthrough();
const ActionSchema = z.object({
  reason: z.string(),
  provider: z.string(),
  title: z.string(),
  message: z.string(),
  label: z.string(),
  link: z.string().optional(),
}).strict();
const StatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }).strict(),
  z.object({ type: z.literal("busy") }).strict(),
  z.object({
    type: z.literal("retry"),
    attempt: z.number().int().nonnegative(),
    message: z.string(),
    next: z.number().nonnegative(),
    action: ActionSchema.optional(),
  }).strict(),
]);

export type HarnessSessionStatus = z.infer<typeof StatusSchema>;
export type HarnessClient = OpencodeClient;

export const createHarnessClient = (origin: string, directory: string): OpencodeClient => {
  if (!URL.canParse(origin) || !isAbsolute(directory)) throw new HarnessContractError("sdk_malformed");
  const url = new URL(origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new HarnessContractError("sdk_malformed");
  return createOpencodeClient({ baseUrl: origin, directory });
};

export const unwrapSdkData = <T>(input: unknown, schema: z.ZodType<T>): T => {
  const envelope = EnvelopeSchema.safeParse(input);
  if (!envelope.success) throw new HarnessContractError("sdk_malformed");
  const hasData = envelope.data.data !== undefined;
  const hasError = envelope.data.error !== undefined;
  if (hasData && hasError) throw new HarnessContractError("sdk_malformed");
  if (hasError) throw new HarnessContractError("sdk_error");
  if (!hasData) throw new HarnessContractError("sdk_malformed");
  const parsed = schema.safeParse(envelope.data.data);
  if (!parsed.success) throw new HarnessContractError("sdk_malformed");
  return parsed.data;
};

export const unwrapSessionId = (input: unknown): string => unwrapSdkData(input, SessionIdSchema).id;

export const unwrapStatusMap = (input: unknown): Readonly<Record<string, HarnessSessionStatus>> => Object.freeze(
  unwrapSdkData(input, z.record(z.string().regex(/^ses_[A-Za-z0-9_-]+$/u), StatusSchema)),
);

export const unwrapTrue = (input: unknown): true => unwrapSdkData(input, z.literal(true));

export const unwrapNoContent = (input: unknown): true => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new HarnessContractError("sdk_malformed");
  }
  if (Reflect.get(input, "error") !== undefined) throw new HarnessContractError("sdk_error");
  const response = Reflect.get(input, "response");
  if (!(response instanceof Response) || response.status !== 204) throw new HarnessContractError("sdk_malformed");
  return true;
};

export const deadlineSignal = (milliseconds: number): AbortSignal => {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 60_000) {
    throw new HarnessContractError("deadline");
  }
  return AbortSignal.timeout(milliseconds);
};
