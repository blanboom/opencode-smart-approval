import { z } from "zod";
import { HarnessContractError } from "./errors";
import type { ScenarioDeadline } from "./scenario-deadline";
import {
  deadlineSignal,
  type HarnessClient,
  unwrapSdkData,
  unwrapSessionId,
  unwrapStatusMap,
  unwrapTrue,
} from "./sdk";

export type BaselineAssistantReceipt = {
  readonly text: "main-ok";
};

export type BaselineToolReceipt = {
  readonly command: "printf main-ok";
  readonly output: string;
};

export type BaselineScenarioReceipt = BaselineAssistantReceipt & BaselineToolReceipt & {
  readonly primarySessionID: string;
  readonly messageCount: number;
  readonly childCount: 0;
  readonly activeStatusCount: 0;
  readonly deleted: true;
};

export type BaselineCaptureKind = "prompt" | "messages" | "children" | "status";

const EnvelopeSchema = z.object({
  info: z.object({ role: z.literal("assistant"), sessionID: z.string().min(1) }).passthrough(),
  parts: z.array(z.unknown()).max(64),
}).passthrough();
const MessageSchema = z.object({
  info: z.object({ sessionID: z.string().min(1) }).passthrough(),
  parts: z.array(z.unknown()).max(64),
}).passthrough();
const BashPartSchema = z.object({
  type: z.literal("tool"),
  tool: z.literal("bash"),
  state: z.object({
    status: z.literal("completed"),
    input: z.object({ command: z.literal("printf main-ok") }).passthrough(),
    output: z.literal("main-ok"),
  }).passthrough(),
}).passthrough();
const TextPartSchema = z.object({ type: z.literal("text"), text: z.literal("main-ok") }).passthrough();

export const parseBaselineAssistant = (
  input: unknown,
  sessionID: string,
): BaselineAssistantReceipt => {
  const parsed = EnvelopeSchema.safeParse(input);
  if (!parsed.success || parsed.data.info.sessionID !== sessionID) throw new HarnessContractError("sdk_malformed");
  const text = parsed.data.parts.flatMap((part) => {
    const candidate = TextPartSchema.safeParse(part);
    return candidate.success ? [candidate.data] : [];
  });
  if (text.length !== 1) throw new HarnessContractError("sdk_malformed");
  return Object.freeze({ text: "main-ok" });
};

export const parseBaselineMessages = (
  input: unknown,
  sessionID: string,
): BaselineToolReceipt => {
  const parsed = z.array(MessageSchema).min(1).max(64).safeParse(input);
  if (!parsed.success || parsed.data.some((message) => message.info.sessionID !== sessionID)) {
    throw new HarnessContractError("sdk_malformed");
  }
  const bash = parsed.data.flatMap((message) => message.parts.flatMap((part) => {
    const candidate = BashPartSchema.safeParse(part);
    return candidate.success ? [candidate.data] : [];
  }));
  if (bash.length !== 1) throw new HarnessContractError("sdk_malformed");
  return Object.freeze({ command: "printf main-ok", output: "main-ok" });
};

export const runBaselineScenario = async (
  client: HarnessClient,
  directory: string,
  deadline: ScenarioDeadline,
  capture?: (kind: BaselineCaptureKind, input: unknown) => void,
): Promise<BaselineScenarioReceipt> => {
  const primarySessionID = unwrapSessionId(await deadline.run((signal) => client.session.create(
    { directory, title: "opencode-smart-approval e2e baseline" },
    { signal },
  )));
  let deleted = false;
  try {
    const prompt = unwrapSdkData(await deadline.run((signal) => client.session.prompt({
      sessionID: primarySessionID,
      directory,
      agent: "build",
      model: { providerID: "openai", modelID: "fixture-primary" },
      parts: [{ type: "text", text: "Call bash once with the exact command `printf main-ok`, then return main-ok." }],
    }, { signal })), z.unknown());
    capture?.("prompt", prompt);
    const assistant = parseBaselineAssistant(prompt, primarySessionID);
    const messages = unwrapSdkData(
      await deadline.run((signal) => client.session.messages(
        { sessionID: primarySessionID, directory, limit: 64 },
        { signal },
      )),
      z.array(z.unknown()).min(2).max(64),
    );
    capture?.("messages", messages);
    const tool = parseBaselineMessages(messages, primarySessionID);
    const children = unwrapSdkData(
      await deadline.run((signal) => client.session.children(
        { sessionID: primarySessionID, directory },
        { signal },
      )),
      z.array(z.object({ id: z.string().min(1) }).passthrough()).max(8),
    );
    capture?.("children", children);
    const statusMap = unwrapStatusMap(await deadline.run((signal) => client.session.status(
      { directory },
      { signal },
    )));
    capture?.("status", statusMap);
    if (children.length !== 0 || Object.keys(statusMap).length !== 0) {
      throw new HarnessContractError("sdk_malformed");
    }
    deleted = unwrapTrue(await deadline.run((signal) => client.session.delete(
      { sessionID: primarySessionID, directory },
      { signal },
    )));
    return Object.freeze({
      ...assistant,
      ...tool,
      primarySessionID,
      messageCount: messages.length,
      childCount: 0,
      activeStatusCount: 0,
      deleted,
    });
  } finally {
    if (!deleted) {
      try {
        unwrapTrue(await client.session.delete({ sessionID: primarySessionID, directory }, { signal: deadlineSignal(2_000) }));
      } catch {
        throw new HarnessContractError("process");
      }
    }
  }
};
