import type { PluginInput } from "@opencode-ai/plugin";
import { z } from "zod";
import { copyBoundedTranscriptJson } from "./transcript-projector";

type RootClient = PluginInput["client"];
type RequiredOptions<T extends (...args: never[]) => unknown> = NonNullable<Parameters<T>[0]>;

export type AgentsOptions = RequiredOptions<RootClient["app"]["agents"]>;
export type LogOptions = RequiredOptions<RootClient["app"]["log"]>;
export type MessagesOptions = RequiredOptions<RootClient["session"]["messages"]>;
export type CreateOptions = RequiredOptions<RootClient["session"]["create"]>;
export type PromptOptions = RequiredOptions<RootClient["session"]["prompt"]>;
export type AbortOptions = RequiredOptions<RootClient["session"]["abort"]>;
export type DeleteOptions = RequiredOptions<RootClient["session"]["delete"]>;

export type ApprovalRootClient = {
  readonly app: {
    readonly agents: (options: AgentsOptions) => Promise<unknown>;
    readonly log: (options: LogOptions) => Promise<unknown>;
  };
  readonly session: {
    readonly messages: (options: MessagesOptions) => Promise<unknown>;
    readonly create: (options: CreateOptions) => Promise<unknown>;
    readonly prompt: (options: PromptOptions) => Promise<unknown>;
    readonly abort: (options: AbortOptions) => Promise<unknown>;
    readonly delete: (options: DeleteOptions) => Promise<unknown>;
  };
};

export type OpenCodeCallFailureCode =
  | "client_unavailable"
  | "transport_error"
  | "malformed_json"
  | "limit_exceeded"
  | "invalid_envelope"
  | "sdk_error"
  | "missing_data"
  | "contradictory_result"
  | "false_result";

export type OpenCodeCallResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly code: OpenCodeCallFailureCode };

export type OpenCodeClientAdapter = {
  agents(input: { readonly directory: string; readonly signal: AbortSignal }): Promise<OpenCodeCallResult>;
  messages(input: { readonly sessionID: string; readonly directory: string; readonly limit: number; readonly signal: AbortSignal }): Promise<OpenCodeCallResult>;
  create(input: { readonly parentID: string; readonly title: string; readonly directory: string; readonly signal: AbortSignal }): Promise<OpenCodeCallResult>;
  prompt(input: { readonly sessionID: string; readonly directory: string; readonly agent: string; readonly tools: Readonly<Record<string, boolean>>; readonly text: string; readonly signal: AbortSignal }): Promise<OpenCodeCallResult>;
  abort(input: { readonly sessionID: string; readonly directory: string; readonly signal: AbortSignal }): Promise<OpenCodeCallResult>;
  delete(input: { readonly sessionID: string; readonly directory: string; readonly signal: AbortSignal }): Promise<OpenCodeCallResult>;
  log(input: { readonly directory: string; readonly service: string; readonly level: "info" | "warn" | "error" | "debug"; readonly message: string; readonly extra: Readonly<Record<string, unknown>>; readonly signal: AbortSignal }): Promise<OpenCodeCallResult>;
};

const ResultEnvelopeSchema = z.looseObject({
  data: z.unknown().optional(),
  error: z.unknown().optional(),
});

const unwrapResult = (input: unknown, requireTrue = false): OpenCodeCallResult => {
  const envelope = ResultEnvelopeSchema.safeParse(input);
  if (!envelope.success) return { ok: false, code: "invalid_envelope" };
  const hasData = envelope.data.data !== undefined;
  const hasError = envelope.data.error !== undefined;
  if (hasData && hasError) return { ok: false, code: "contradictory_result" };
  if (hasError) return { ok: false, code: "sdk_error" };
  if (!hasData) return { ok: false, code: "missing_data" };
  if (requireTrue && envelope.data.data !== true) return { ok: false, code: "false_result" };
  return { ok: true, data: envelope.data.data };
};

const invoke = async (
  request: () => Promise<unknown>,
  requireTrue = false,
  prepare: (input: unknown) => OpenCodeCallResult = (input) => ({ ok: true, data: input }),
): Promise<OpenCodeCallResult> => {
  try {
    const prepared = prepare(await request());
    return prepared.ok ? unwrapResult(prepared.data, requireTrue) : prepared;
  } catch (error) {
    if (error instanceof Error) return { ok: false, code: "transport_error" };
    return { ok: false, code: "transport_error" };
  }
};

const boundedTranscriptEnvelope = (input: unknown): OpenCodeCallResult => {
  const copied = copyBoundedTranscriptJson(input);
  if (copied.ok) return { ok: true, data: copied.value };
  return { ok: false, code: copied.reason === "malformed" ? "malformed_json" : "limit_exceeded" };
};

export const createOpenCodeClientAdapter = (
  client: ApprovalRootClient | undefined,
): OpenCodeClientAdapter => {
  const unavailable = async (): Promise<OpenCodeCallResult> => ({ ok: false, code: "client_unavailable" });
  if (!client) {
    return {
      agents: unavailable,
      messages: unavailable,
      create: unavailable,
      prompt: unavailable,
      abort: unavailable,
      delete: unavailable,
      log: unavailable,
    };
  }
  return {
    agents: ({ directory, signal }) => invoke(() => client.app.agents({ query: { directory }, signal })),
    messages: ({ sessionID, directory, limit, signal }) => invoke(
      () => client.session.messages({
        path: { id: sessionID },
        query: { directory, limit },
        signal,
      }),
      false,
      boundedTranscriptEnvelope,
    ),
    create: ({ parentID, title, directory, signal }) => invoke(() => client.session.create({
      query: { directory },
      body: { parentID, title },
      signal,
    })),
    prompt: ({ sessionID, directory, agent, tools, text, signal }) => invoke(() => client.session.prompt({
      path: { id: sessionID },
      query: { directory },
      body: { agent, tools: { ...tools }, parts: [{ type: "text", text }] },
      signal,
    })),
    abort: ({ sessionID, directory, signal }) => invoke(() => client.session.abort({
      path: { id: sessionID },
      query: { directory },
      signal,
    }), true),
    delete: ({ sessionID, directory, signal }) => invoke(() => client.session.delete({
      path: { id: sessionID },
      query: { directory },
      signal,
    }), true),
    log: ({ directory, service, level, message, extra, signal }) => invoke(() => client.app.log({
      query: { directory },
      body: { service, level, message, extra: { ...extra } },
      signal,
    })),
  };
};
