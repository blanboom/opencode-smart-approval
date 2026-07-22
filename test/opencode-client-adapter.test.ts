import { describe, expect, test } from "bun:test";
import {
  createOpenCodeClientAdapter,
  type OpenCodeCallResult,
  type OpenCodeClientAdapter,
} from "../src/opencode-client-adapter";
import { fakeClient, type FakeMethod } from "./fixtures/opencode-client-fake";

const DIRECTORY = "/workspace";
const SESSION_ID = "session-child";

const invoke = (
  adapter: OpenCodeClientAdapter,
  method: FakeMethod,
  signal: AbortSignal,
): Promise<OpenCodeCallResult> => {
  switch (method) {
    case "agents":
      return adapter.agents({ directory: DIRECTORY, signal });
    case "messages":
      return adapter.messages({ sessionID: "parent", directory: DIRECTORY, limit: 4, signal });
    case "create":
      return adapter.create({ parentID: "parent", title: "title", directory: DIRECTORY, signal });
    case "prompt":
      return adapter.prompt({
        sessionID: SESSION_ID,
        directory: DIRECTORY,
        agent: "reviewer",
        tools: { "*": false, opencode_smart_approval_read: true },
        text: "request-json",
        signal,
      });
    case "abort":
      return adapter.abort({ sessionID: SESSION_ID, directory: DIRECTORY, signal });
    case "delete":
      return adapter.delete({ sessionID: SESSION_ID, directory: DIRECTORY, signal });
    case "log":
      return adapter.log({
        directory: DIRECTORY,
        service: "approval",
        level: "warn",
        message: "review.cleanup",
        extra: { event: "late_create" },
        signal,
      });
  }
};

const expectedOptions = (method: FakeMethod, signal: AbortSignal): unknown => {
  switch (method) {
    case "agents":
      return { query: { directory: DIRECTORY }, signal };
    case "messages":
      return { path: { id: "parent" }, query: { directory: DIRECTORY, limit: 4 }, signal };
    case "create":
      return { query: { directory: DIRECTORY }, body: { parentID: "parent", title: "title" }, signal };
    case "prompt":
      return {
        path: { id: SESSION_ID },
        query: { directory: DIRECTORY },
        body: {
          agent: "reviewer",
          tools: { "*": false, opencode_smart_approval_read: true },
          parts: [{ type: "text", text: "request-json" }],
        },
        signal,
      };
    case "abort":
    case "delete":
      return { path: { id: SESSION_ID }, query: { directory: DIRECTORY }, signal };
    case "log":
      return {
        query: { directory: DIRECTORY },
        body: {
          service: "approval",
          level: "warn",
          message: "review.cleanup",
          extra: { event: "late_create" },
        },
        signal,
      };
  }
};

const METHOD_CASES = [
  ["agents"],
  ["messages"],
  ["create"],
  ["prompt"],
  ["abort"],
  ["delete"],
  ["log"],
] as const;
const METHODS: readonly FakeMethod[] = METHOD_CASES.map(([method]) => method);

describe("OpenCode root client adapter", () => {
  test.each(METHOD_CASES)("uses one exact options object for %s", async (method) => {
    // Given a root client capture returning valid data.
    const fake = fakeClient(async () => ({ data: method === "abort" || method === "delete" ? true : { ok: true } }));
    const adapter = createOpenCodeClientAdapter(fake.client);
    const signal = new AbortController().signal;

    // When the typed adapter calls the selected root method.
    const result = await invoke(adapter, method, signal);

    // Then the exact nested path/query/body/signal shape and data are retained.
    expect(fake.calls).toEqual([{ method, options: expectedOptions(method, signal) }]);
    expect(result.ok).toBe(true);
  });

  test.each(METHOD_CASES)("maps %s transport rejection without leaking details", async (method) => {
    // Given a root client method rejecting with provider-controlled text.
    const fake = fakeClient(async () => { throw new Error("private transport detail"); });
    const adapter = createOpenCodeClientAdapter(fake.client);

    // When the adapter invokes the method.
    const result = await invoke(adapter, method, new AbortController().signal);

    // Then the failure is a fixed transport code.
    expect(result).toEqual({ ok: false, code: "transport_error" });
    expect(JSON.stringify(result)).not.toContain("private transport detail");
  });

  test.each([
    ["error", { error: { secret: "detail" } }, "sdk_error"],
    ["missing", {}, "missing_data"],
    ["contradictory", { data: true, error: { secret: "detail" } }, "contradictory_result"],
    ["invalid", null, "invalid_envelope"],
  ] as const)("rejects a %s result envelope for every method", async (_label, response, code) => {
    // Given each root method returns the same invalid default result envelope.
    const fake = fakeClient(async () => response);
    const adapter = createOpenCodeClientAdapter(fake.client);

    // When every method crosses the shared unwrap boundary.
    const results = await Promise.all(METHODS.map((method) => invoke(adapter, method, new AbortController().signal)));

    // Then every result receives the same fixed failure classification.
    expect(results).toEqual(METHODS.map(() => ({ ok: false, code })));
  });

  test.each([["abort"], ["delete"]] as const)("rejects false %s data", async (method) => {
    // Given a lifecycle boolean method returns false.
    const fake = fakeClient(async () => ({ data: false }));
    const adapter = createOpenCodeClientAdapter(fake.client);

    // When the lifecycle call is unwrapped.
    const result = await invoke(adapter, method, new AbortController().signal);

    // Then false remains a distinct failure for lifecycle race handling.
    expect(result).toEqual({ ok: false, code: "false_result" });
  });

  test("fails closed without a plugin-supplied client", async () => {
    // Given the plugin input client is absent.
    const adapter = createOpenCodeClientAdapter(undefined);

    // When an ordinary root call is requested.
    const result = await adapter.agents({ directory: DIRECTORY, signal: new AbortController().signal });

    // Then no fallback client is created and the call fails closed.
    expect(result).toEqual({ ok: false, code: "client_unavailable" });
  });
});
