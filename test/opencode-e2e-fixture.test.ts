import { describe, expect, test } from "bun:test";
import {
  encodeServerSentEvents,
  finalTextEvents,
  functionCallEvents,
  parseProviderRequest,
  responseEventTypes,
} from "../scripts/opencode-e2e/provider-protocol";
import {
  createDeterministicProviderHandler,
  type ProviderFixtureState,
} from "./fixtures/deterministic-openai-provider";

const providerInput = {
  model: "fixture-primary",
  input: [{ role: "user", content: "run fixture" }],
  tools: [{ type: "function", name: "bash" }],
  stream: true,
} as const;

describe("deterministic Responses provider protocol", () => {
  test("accepts only the fixture bearer and required request fields", () => {
    // Given an exact localhost Responses request.
    const authorization = "Bearer fixture-key";

    // When the provider boundary parses it.
    const parsed = parseProviderRequest(authorization, providerInput);

    // Then the model, input, tools, and stream flag are preserved as typed data.
    expect(parsed).toEqual(providerInput);
  });

  test("rejects wrong auth, missing stream, and unknown request fields", () => {
    // Given three malformed provider requests.
    const wrongAuth = () => parseProviderRequest("Bearer owner-secret", providerInput);
    const missingStream = () => parseProviderRequest("Bearer fixture-key", { ...providerInput, stream: undefined });
    const unknown = () => parseProviderRequest("Bearer fixture-key", { ...providerInput, apiKey: "owner-secret" });

    // When each request crosses the provider boundary.
    // Then every malformed shape fails with the same redacted category.
    expect(wrongAuth).toThrow("provider_request");
    expect(missingStream).toThrow("provider_request");
    expect(unknown).toThrow("provider_request");
  });

  test("emits the exact function-call event order and arguments", () => {
    // Given fixed response, call, tool, and argument identifiers.
    const argumentsJson = "{\"command\":\"printf main-ok\"}";

    // When the function-call stream is built.
    const events = functionCallEvents("resp-1", "call-1", "bash", argumentsJson);

    // Then the pinned Responses event grammar and arguments are exact.
    expect(responseEventTypes(events)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events[3]).toMatchObject({ arguments: argumentsJson });
  });

  test("emits the exact final-text event order and SSE termination", () => {
    // Given fixed response/message identifiers and ordinary assistant text.
    const events = finalTextEvents("resp-2", "msg-2", "main-ok");

    // When the events are encoded for the wire.
    const encoded = encodeServerSentEvents(events);

    // Then the text grammar is complete and the stream ends once.
    expect(responseEventTypes(events)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(encoded.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(encoded.match(/data: \[DONE\]/gu)).toHaveLength(1);
  });
});

describe("deterministic localhost provider handler", () => {
  test("serves one exact function stream and records its typed request", async () => {
    // Given one planned function response and an exact Responses request.
    const state: ProviderFixtureState = { steps: [{
      kind: "function",
      model: "fixture-primary",
      responseId: "resp-1",
      callId: "call-1",
      toolName: "bash",
      argumentsJson: "{\"command\":\"printf main-ok\"}",
    }], requests: [] };
    const handler = createDeterministicProviderHandler(state);
    const request = new Request("http://127.0.0.1:43210/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer fixture-key", "content-type": "application/json" },
      body: JSON.stringify(providerInput),
    });

    // When the request reaches the wire-level handler.
    const response = await handler(request);
    const body = await response.text();

    // Then the exact route succeeds, emits the function event, and records one typed request.
    expect(response.status).toBe(200);
    expect(body).toContain("response.function_call_arguments.done");
    expect(state.requests).toEqual([{ index: 0, path: "/v1/responses", request: providerInput }]);
  });

  test("returns 404 for every non-Responses route without consuming a step", async () => {
    // Given one pending response and the forbidden chat-completions route.
    const state: ProviderFixtureState = { steps: [{ kind: "malformed", model: "fixture-primary" }], requests: [] };
    const handler = createDeterministicProviderHandler(state);

    // When the forbidden route is requested.
    const response = await handler(new Request("http://127.0.0.1:43210/v1/chat/completions", { method: "POST" }));

    // Then it is rejected and no provider step is consumed.
    expect(response.status).toBe(404);
    expect(state.requests).toEqual([]);
  });

  test("exposes deterministic malformed and HTTP-500 fault branches", async () => {
    // Given consecutive malformed-stream and HTTP-error steps.
    const state: ProviderFixtureState = { steps: [
      { kind: "malformed", model: "fixture-fault" },
      { kind: "http_error", model: "fixture-fault" },
    ], requests: [] };
    const handler = createDeterministicProviderHandler(state);
    const request = () => new Request("http://127.0.0.1:43210/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer fixture-key", "content-type": "application/json" },
      body: JSON.stringify({ ...providerInput, model: "fixture-fault" }),
    });

    // When both fault requests are handled in order.
    const malformed = await handler(request());
    const failed = await handler(request());

    // Then each branch has an observable and distinct wire failure.
    expect(await malformed.text()).toBe("event: response.created\ndata: {malformed}\n\n");
    expect(failed.status).toBe(500);
  });

  test("keeps a hang response pending until the exact request aborts", async () => {
    // Given one hanging provider step and its dedicated abort signal.
    const state: ProviderFixtureState = { steps: [{ kind: "hang", model: "fixture-hang" }], requests: [], abortedRequests: [] };
    const handler = createDeterministicProviderHandler(state);
    const controller = new AbortController();
    const request = new Request("http://127.0.0.1:43210/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer fixture-key", "content-type": "application/json" },
      body: JSON.stringify({ ...providerInput, model: "fixture-hang" }),
      signal: controller.signal,
    });

    // When the exact in-flight request is aborted.
    const pending = handler(request);
    controller.abort();
    const response = await pending;
    await response.text();

    // Then the hanging branch settles only as an aborted request.
    expect(response.status).toBe(200);
    expect(state.abortedRequests).toEqual([0]);
  });

  test("echoes only the exact prior authorization phrase into an assistant fixture response", async () => {
    // Given a dynamic assistant-copy step and a request containing one prior confirmation challenge.
    const phrase = `AUTHORIZE opencode-smart-approval ${"a".repeat(43)}`;
    const state: ProviderFixtureState = { steps: [{
      kind: "authorization_echo",
      model: "fixture-primary",
      responseId: "resp-copy",
      messageId: "msg-copy",
      prefix: "assistant-copy:",
    }], requests: [] };
    const handler = createDeterministicProviderHandler(state);
    const request = new Request("http://127.0.0.1:43210/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer fixture-key", "content-type": "application/json" },
      body: JSON.stringify({ ...providerInput, input: [{ role: "tool", content: `blocked\n${phrase}` }] }),
    });

    // When the deterministic provider consumes the dynamic step.
    const body = await (await handler(request)).text();

    // Then only the exact phrase is copied and no static token is required in the fixture plan.
    expect(body).toContain(`assistant-copy:${phrase}`);
    expect(body).not.toContain("blocked\\n");
  });
});
