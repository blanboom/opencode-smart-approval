import { z } from "zod";
import { HarnessContractError } from "./errors";

export type ConfirmationChallengeReceipt = Readonly<{
  readonly phrase: string;
  readonly token: string;
  readonly effectSha256: string;
  readonly disclosureSha256: string;
  readonly replaced: boolean;
}>;

const MessageSchema = z.object({
  info: z.object({ sessionID: z.string().min(1) }).passthrough(),
  parts: z.array(z.unknown()).max(256),
}).passthrough();
const BashPartSchema = z.object({
  type: z.literal("tool"),
  tool: z.literal("bash"),
  state: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("completed"),
      input: z.object({ command: z.string().min(1).max(16_384) }).passthrough(),
      output: z.string().max(65_536),
    }).passthrough(),
    z.object({
      status: z.literal("error"),
      input: z.object({ command: z.string().min(1).max(16_384) }).passthrough(),
      error: z.string().min(1).max(32_768),
    }).passthrough(),
  ]),
}).passthrough();

const parsedMessages = (input: unknown, sessionID: string) => {
  const parsed = z.array(MessageSchema).min(1).max(128).safeParse(input);
  if (!parsed.success || parsed.data.some((message) => message.info.sessionID !== sessionID)) {
    throw new HarnessContractError("sdk_malformed");
  }
  return parsed.data;
};

const bashParts = (input: unknown, sessionID: string) => parsedMessages(input, sessionID).flatMap(
  (message) => message.parts.flatMap((part) => {
    const parsed = BashPartSchema.safeParse(part);
    return parsed.success ? [parsed.data] : [];
  }),
);

const exactMatch = (pattern: RegExp, input: string): string => {
  const matches = input.match(pattern) ?? [];
  if (matches.length !== 1 || matches[0] === undefined) throw new HarnessContractError("sdk_malformed");
  return matches[0];
};

export const parseConfirmationChallenge = (
  input: unknown,
  sessionID: string,
  command: string,
): ConfirmationChallengeReceipt => {
  const candidates = bashParts(input, sessionID).filter(
    (part) => part.state.status === "error" && part.state.input.command === command && part.state.error.includes("authorization_phrase="),
  );
  if (candidates.length !== 1 || candidates[0]?.state.status !== "error") {
    throw new HarnessContractError("sdk_malformed");
  }
  const error = candidates[0].state.error;
  const phrase = exactMatch(/AUTHORIZE opencode-smart-approval [A-Za-z0-9_-]{43}/gu, error);
  const token = phrase.slice("AUTHORIZE opencode-smart-approval ".length);
  const effectSha256 = exactMatch(/(?<=effect_sha256=)[a-f0-9]{64}/gu, error);
  const disclosureSha256 = exactMatch(/(?<=disclosure_sha256=)[a-f0-9]{64}/gu, error);
  const replacement = exactMatch(/(?<=prior_challenge_replaced=)(?:true|false)/gu, error);
  return Object.freeze({ phrase, token, effectSha256, disclosureSha256, replaced: replacement === "true" });
};

export const parseExecutionSummary = (
  input: unknown,
  sessionID: string,
  allowedCommands: readonly string[],
): Readonly<{ readonly completed: number; readonly errors: number; readonly commands: readonly string[] }> => {
  const allowed = new Set(allowedCommands);
  const parts = bashParts(input, sessionID);
  if (parts.some((part) => !allowed.has(part.state.input.command))) throw new HarnessContractError("sdk_malformed");
  return Object.freeze({
    completed: parts.filter((part) => part.state.status === "completed").length,
    errors: parts.filter((part) => part.state.status === "error").length,
    commands: Object.freeze(parts.map((part) => part.state.input.command)),
  });
};

export const requireAuthorizationFailure = (
  input: unknown,
  sessionID: string,
  command: string,
  code: string,
): true => {
  if (!/^[a-z_]+$/u.test(code)) throw new HarnessContractError("sdk_malformed");
  const expected = `reviewer_failure:authorization_${code}`;
  const failures = bashParts(input, sessionID).filter(
    (part) => part.state.status === "error" && part.state.input.command === command && part.state.error.includes(expected),
  );
  if (failures.length !== 1) throw new HarnessContractError("sdk_malformed");
  return true;
};

export const requireConfirmedReviewerRequest = (
  request: unknown,
  challenge: ConfirmationChallengeReceipt,
): Readonly<{ readonly effectSha256: string; readonly disclosureSha256: string; readonly rawPhraseAbsent: true }> => {
  const strings: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      strings.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(request);
  const serialized = `${JSON.stringify(request)}\n${strings.join("\n")}`;
  if (
    !serialized.includes('"authorization_proof"') ||
    !serialized.includes(`"effect_sha256":"${challenge.effectSha256}"`) ||
    !serialized.includes(`"disclosure_sha256":"${challenge.disclosureSha256}"`) ||
    !serialized.includes("[explicit authorization confirmed by plugin]") ||
    serialized.includes(challenge.phrase) || serialized.includes(challenge.token)
  ) throw new HarnessContractError("provider_request");
  return Object.freeze({
    effectSha256: challenge.effectSha256,
    disclosureSha256: challenge.disclosureSha256,
    rawPhraseAbsent: true,
  });
};

export const requireUnconfirmedReviewerRequest = (
  request: unknown,
  forbidden?: ConfirmationChallengeReceipt,
): true => {
  const serialized = JSON.stringify(request);
  if (
    serialized.includes('"authorization_proof"') ||
    (forbidden !== undefined && (serialized.includes(forbidden.phrase) || serialized.includes(forbidden.token)))
  ) throw new HarnessContractError("provider_request");
  return true;
};
