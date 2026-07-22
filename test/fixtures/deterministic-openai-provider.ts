import {
  encodeServerSentEvents,
  finalTextEvents,
  functionCallEvents,
  parseProviderRequest,
  type ProviderRequest,
} from "../../scripts/opencode-e2e/provider-protocol";
import { HarnessContractError } from "../../scripts/opencode-e2e/errors";

export type ProviderStep =
  | {
      readonly kind: "function";
      readonly model: string;
      readonly responseId: string;
      readonly callId: string;
      readonly toolName: string;
      readonly argumentsJson: string;
    }
  | {
      readonly kind: "text";
      readonly model: string;
      readonly responseId: string;
      readonly messageId: string;
      readonly text: string;
    }
  | {
      readonly kind: "authorization_echo";
      readonly model: string;
      readonly responseId: string;
      readonly messageId: string;
      readonly prefix: string;
    }
  | { readonly kind: "malformed"; readonly model: string }
  | { readonly kind: "http_error"; readonly model: string }
  | { readonly kind: "hang"; readonly model: string };

export type ProviderRequestReceipt = {
  readonly index: number;
  readonly path: "/v1/responses";
  readonly request: ProviderRequest;
};

export type ProviderFixtureState = {
  readonly steps: readonly ProviderStep[];
  readonly requests: ProviderRequestReceipt[];
  readonly abortedRequests?: number[];
};

export type RunningDeterministicProvider = {
  readonly origin: string;
  readonly pid: number;
  readonly port: number;
  readonly state: ProviderFixtureState;
  stop(): Promise<void>;
};

const eventStream = (body: string): Response => new Response(body, {
  status: 200,
  headers: {
    "cache-control": "no-cache",
    "content-type": "text/event-stream; charset=utf-8",
  },
});

const hangingEventStream = (signal: AbortSignal, onAbort: () => void): Response => {
  let settled = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const keepAlive = setInterval(() => {}, 250);
  const finish = (close: boolean): void => {
    if (settled) return;
    settled = true;
    clearInterval(keepAlive);
    onAbort();
    if (close) controller?.close();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(input) {
      controller = input;
      if (signal.aborted) finish(true);
      else signal.addEventListener("abort", () => finish(true), { once: true });
    },
    cancel() { finish(false); },
  });
  return new Response(stream, {
    status: 200,
    headers: { "cache-control": "no-cache", "content-type": "text/event-stream; charset=utf-8" },
  });
};

const assertNever = (step: never): never => {
  void step;
  throw new HarnessContractError("provider_stream");
};

const authorizationPhrase = (input: ProviderRequest): string => {
  const matches = JSON.stringify(input.input).match(/AUTHORIZE opencode-smart-approval [A-Za-z0-9_-]{43}/gu) ?? [];
  const unique = [...new Set(matches)];
  if (unique.length !== 1 || unique[0] === undefined) throw new HarnessContractError("provider_request");
  return unique[0];
};

export const createDeterministicProviderHandler = (
  state: ProviderFixtureState,
): ((request: Request) => Promise<Response>) => async (request) => {
  const url = new URL(request.url);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/v1/responses" || request.method !== "POST") {
    return new Response("not found", { status: 404 });
  }
  let input: unknown;
  try {
    input = await request.json();
  } catch (error) {
    if (error instanceof SyntaxError) return new Response("invalid request", { status: 400 });
    throw error;
  }
  let parsed: ProviderRequest;
  try {
    parsed = parseProviderRequest(request.headers.get("authorization"), input);
  } catch (error) {
    if (error instanceof HarnessContractError) return new Response(error.code, { status: 401 });
    throw error;
  }
  const index = state.requests.length;
  const step = state.steps[index];
  if (!step || step.model !== parsed.model) return new Response("provider plan mismatch", { status: 422 });
  state.requests.push(Object.freeze({ index, path: "/v1/responses", request: parsed }));
  switch (step.kind) {
    case "function":
      return eventStream(encodeServerSentEvents(functionCallEvents(
        step.responseId,
        step.callId,
        step.toolName,
        step.argumentsJson,
      )));
    case "text":
      return eventStream(encodeServerSentEvents(finalTextEvents(step.responseId, step.messageId, step.text)));
    case "authorization_echo":
      return eventStream(encodeServerSentEvents(finalTextEvents(
        step.responseId,
        step.messageId,
        `${step.prefix}${authorizationPhrase(parsed)}`,
      )));
    case "malformed":
      return eventStream("event: response.created\ndata: {malformed}\n\n");
    case "http_error":
      return Response.json({ error: { type: "fixture_error" } }, { status: 500 });
    case "hang":
      return hangingEventStream(request.signal, () => { state.abortedRequests?.push(index); });
    default:
      return assertNever(step);
  }
};

export const startDeterministicProvider = (steps: readonly ProviderStep[]): RunningDeterministicProvider => {
  const state: ProviderFixtureState = { steps, requests: [], abortedRequests: [] };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createDeterministicProviderHandler(state) });
  const port = server.port;
  if (!Number.isSafeInteger(port) || port === undefined || port < 1) {
    void server.stop(true);
    throw new HarnessContractError("provider_request");
  }
  return Object.freeze({
    origin: `http://127.0.0.1:${port}`,
    pid: process.pid,
    port,
    state,
    stop: async () => { await server.stop(true); },
  });
};
