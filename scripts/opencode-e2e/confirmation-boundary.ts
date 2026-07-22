import { z } from "zod";
import { HarnessContractError } from "./errors";

const FILLER_COUNT = 33;
const EXPECTED_MESSAGE_COUNT = 39;
const LATEST_PAGE_COUNT = 20;
const MessageSchema = z.object({
  info: z.object({
    id: z.string().min(1),
    sessionID: z.string().min(1),
    role: z.enum(["user", "assistant"]),
    time: z.object({ created: z.number().finite() }).passthrough(),
  }).passthrough(),
  parts: z.array(z.unknown()).max(256),
}).passthrough();
const TextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  synthetic: z.boolean().optional(),
  ignored: z.boolean().optional(),
}).passthrough();

export type BoundaryFillReceipt = Readonly<{
  readonly batchDurationsMilliseconds: readonly number[];
  readonly batchSize: 1;
  readonly fillerCount: 33;
  readonly totalDurationMilliseconds: number;
}>;

export const appendBoundaryFillers = async (
  append: (text: string) => Promise<void>,
): Promise<BoundaryFillReceipt> => {
  const totalStarted = performance.now();
  const durations: number[] = [];
  for (let index = 0; index < FILLER_COUNT; index += 1) {
    const batchStarted = performance.now();
    await append(`boundary filler ${String(index)}`);
    durations.push(Math.ceil(performance.now() - batchStarted));
  }
  return Object.freeze({
    batchDurationsMilliseconds: Object.freeze(durations),
    batchSize: 1,
    fillerCount: FILLER_COUNT,
    totalDurationMilliseconds: Math.ceil(performance.now() - totalStarted),
  });
};

export const requireBoundaryEvictionTranscript = (
  input: unknown,
  sessionID: string,
  phrase: string,
): Readonly<{
  readonly challengeBoundaryAbsent: true;
  readonly fillerOrder: readonly number[];
  readonly latestPageCount: 20;
  readonly messageCount: 39;
}> => {
  const parsed = z.array(MessageSchema).length(EXPECTED_MESSAGE_COUNT).safeParse(input);
  if (!parsed.success || parsed.data.some((message) => message.info.sessionID !== sessionID)) {
    throw new HarnessContractError("sdk_malformed");
  }
  for (let index = 1; index < parsed.data.length; index += 1) {
    const previous = parsed.data[index - 1]?.info;
    const current = parsed.data[index]?.info;
    if (!previous || !current || current.time.created < previous.time.created
      || (current.time.created === previous.time.created && current.id <= previous.id)) {
      throw new HarnessContractError("sdk_malformed");
    }
  }
  const fillerOrder = parsed.data.flatMap((message) => message.info.role === "user"
    ? message.parts.flatMap((part) => {
      const text = TextPartSchema.safeParse(part);
      const match = text.success ? /^boundary filler ([0-9]+)$/u.exec(text.data.text) : null;
      if (!text.success || match === null) return [];
      if (text.data.synthetic === true || text.data.ignored === true) throw new HarnessContractError("sdk_malformed");
      return [Number(match[1])];
    })
    : []);
  if (fillerOrder.length !== FILLER_COUNT || fillerOrder.some((value, index) => value !== index)) {
    throw new HarnessContractError("sdk_malformed");
  }
  const latest = parsed.data.slice(-LATEST_PAGE_COUNT);
  const serializedLatest = JSON.stringify(latest);
  const phraseUsers = latest.filter((message) => message.info.role === "user"
    && message.parts.some((part) => TextPartSchema.safeParse(part).data?.text === phrase));
  if (phraseUsers.length !== 1 || serializedLatest.includes(`authorization_phrase=${phrase}`)) {
    throw new HarnessContractError("sdk_malformed");
  }
  return Object.freeze({
    challengeBoundaryAbsent: true,
    fillerOrder: Object.freeze(fillerOrder),
    latestPageCount: LATEST_PAGE_COUNT,
    messageCount: EXPECTED_MESSAGE_COUNT,
  });
};
