import { z } from "zod";
import { validateCreatedReviewSession, type CreatedSessionExpectation } from "../../src/review-session-schema";
import { HarnessContractError } from "./errors";
import type { HarnessSessionStatus } from "./sdk";

export type RetainedChildReceipt = Readonly<{
  readonly childID: string;
  readonly parentID: string;
  readonly directory: string;
}>;

const ChildDescriptorSchema = z.object({
  id: z.string().regex(/^ses_[A-Za-z0-9_-]+$/u),
  parentID: z.string().regex(/^ses_[A-Za-z0-9_-]+$/u),
  directory: z.string().min(1),
}).passthrough();

const ReaderProbeMessageSchema = z.object({
  info: z.object({ sessionID: z.string().min(1) }).passthrough(),
  parts: z.array(z.unknown()).max(64),
}).passthrough();
const ReaderProbePartSchema = z.object({
  type: z.literal("tool"),
  tool: z.literal("opencode_smart_approval_read"),
  state: z.object({
    status: z.literal("completed"),
    input: z.object({ path: z.string().min(1), offset: z.literal(0) }).passthrough(),
    output: z.literal("{\"ok\":false,\"error\":\"revoked\"}"),
  }).passthrough(),
}).passthrough();

export const parseRetainedChild = (
  children: readonly unknown[],
  fetched: unknown,
  expected: CreatedSessionExpectation,
): RetainedChildReceipt => {
  if (children.length !== 1) throw new HarnessContractError("sdk_malformed");
  const child = children[0];
  const listed = validateCreatedReviewSession(child, expected);
  const exact = validateCreatedReviewSession(fetched, expected);
  const descriptor = ChildDescriptorSchema.safeParse(fetched);
  if (!listed.ok || !exact.ok || listed.childID !== exact.childID || !descriptor.success) {
    throw new HarnessContractError("sdk_malformed");
  }
  return Object.freeze({
    childID: exact.childID,
    parentID: descriptor.data.parentID,
    directory: descriptor.data.directory,
  });
};

export const requireRetainedStatusAbsent = (
  status: Readonly<Record<string, HarnessSessionStatus>>,
  childID: string,
): true => {
  if (!/^ses_[A-Za-z0-9_-]+$/u.test(childID) || Object.hasOwn(status, childID)) {
    throw new HarnessContractError("sdk_malformed");
  }
  return true;
};

export const parseRetainedReaderProbe = (
  input: unknown,
  childID: string,
  path: string,
): Readonly<{ readonly output: "{\"ok\":false,\"error\":\"revoked\"}" }> => {
  const messages = z.array(ReaderProbeMessageSchema).min(1).max(64).safeParse(input);
  if (!messages.success || messages.data.some((message) => message.info.sessionID !== childID)) {
    throw new HarnessContractError("sdk_malformed");
  }
  const probes = messages.data.flatMap((message) => message.parts.flatMap((part) => {
    const parsed = ReaderProbePartSchema.safeParse(part);
    return parsed.success ? [parsed.data] : [];
  }));
  if (probes.length !== 1 || probes[0]?.state.input.path !== path) throw new HarnessContractError("sdk_malformed");
  return Object.freeze({ output: "{\"ok\":false,\"error\":\"revoked\"}" });
};
