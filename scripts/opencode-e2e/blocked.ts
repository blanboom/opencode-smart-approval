import { z } from "zod";
import { HarnessContractError } from "./errors";

const MessageSchema = z.object({
  info: z.object({ sessionID: z.string().min(1) }).passthrough(),
  parts: z.array(z.unknown()).max(64),
}).passthrough();
const FailedBashSchema = z.object({
  type: z.literal("tool"),
  tool: z.literal("bash"),
  state: z.object({
    status: z.literal("error"),
    input: z.object({ command: z.string().min(1).max(4_096) }).passthrough(),
    error: z.string().min(1).max(4_096),
  }).passthrough(),
}).passthrough();
const TextPartSchema = z.object({ type: z.literal("text"), text: z.string().min(1).max(4_096) }).passthrough();

export const parseBlockedTool = (
  input: unknown,
  sessionID: string,
  command: string,
): Readonly<{ command: string; error: string }> => {
  const parsed = z.array(MessageSchema).min(1).max(64).safeParse(input);
  if (!parsed.success || parsed.data.some((message) => message.info.sessionID !== sessionID)) {
    throw new HarnessContractError("sdk_malformed");
  }
  const failed = parsed.data.flatMap((message) => message.parts.flatMap((part) => {
    const candidate = FailedBashSchema.safeParse(part);
    return candidate.success ? [candidate.data] : [];
  }));
  if (failed.length !== 1 || failed[0]?.state.input.command !== command) {
    throw new HarnessContractError("sdk_malformed");
  }
  return Object.freeze({ command, error: failed[0].state.error });
};

export const parseBlockedAssistant = (
  input: unknown,
  sessionID: string,
  expectedText: string,
): Readonly<{ text: string }> => {
  const parsed = MessageSchema.safeParse(input);
  if (
    !parsed.success ||
    parsed.data.info.sessionID !== sessionID ||
    Reflect.get(parsed.data.info, "role") !== "assistant"
  ) throw new HarnessContractError("sdk_malformed");
  const text = parsed.data.parts.flatMap((part) => {
    const candidate = TextPartSchema.safeParse(part);
    return candidate.success ? [candidate.data.text] : [];
  });
  if (text.length !== 1 || text[0] !== expectedText) throw new HarnessContractError("sdk_malformed");
  return Object.freeze({ text: expectedText });
};
