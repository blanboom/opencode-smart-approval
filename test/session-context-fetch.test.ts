import { describe, expect, test } from "bun:test";
import { fetchSessionContext } from "../src/session-context";

const ordinaryUserEntry = (text: string) => ({
  info: {
    id: "message-user",
    sessionID: "parent-session",
    role: "user",
    time: { created: 12 },
    agent: "build",
    model: { providerID: "fixture", modelID: "model" },
  },
  parts: [{
    id: "part-text",
    sessionID: "parent-session",
    messageID: "message-user",
    type: "text",
    text,
  }],
});

describe("session transcript fetch boundary", () => {
  test("uses one exact root request and returns separated available projections", async () => {
    // Given one valid ordinary user message and a typed client capture.
    const calls: unknown[] = [];
    const signal = new AbortController().signal;
    const client = {
      session: {
        messages: async (options: unknown) => {
          calls.push(options);
          return { data: [ordinaryUserEntry("approved context")] };
        },
      },
    };

    // When the transcript boundary fetches the parent once.
    const snapshot = await fetchSessionContext({
      client,
      parentSessionID: "parent-session",
      canonicalDirectory: "/workspace",
      limit: 4,
      signal,
    });

    // Then the SDK shape is exact and reviewer/auth projections remain separate.
    expect(calls).toEqual([{
      path: { id: "parent-session" },
      query: { directory: "/workspace", limit: 4 },
      signal,
    }]);
    expect(snapshot).toEqual({
      reviewer: {
        status: "available",
        messages: [{ role: "user", parts: [{ type: "text", text: "approved context" }] }],
      },
      authorizationMessages: [{
        messageID: "message-user",
        sessionID: "parent-session",
        created: 12,
        responsePosition: 0,
        text: "approved context",
      }],
    });
  });

  test("returns disabled without a client call when context is disabled", async () => {
    // Given a client whose messages method would reveal an accidental call.
    let calls = 0;
    const client = { session: { messages: async () => { calls += 1; return { data: [] }; } } };

    // When a zero transcript limit disables context.
    const snapshot = await fetchSessionContext({
      client,
      parentSessionID: "parent-session",
      canonicalDirectory: "/workspace",
      limit: 0,
      signal: new AbortController().signal,
    });

    // Then only disabled status remains and the SDK is untouched.
    expect(snapshot).toEqual({ reviewer: { status: "disabled" }, authorizationMessages: [] });
    expect(calls).toBe(0);
  });

  test("returns sanitized unavailable status for an SDK error", async () => {
    // Given a root client returning provider-controlled error details.
    const client = {
      session: {
        messages: async () => ({ error: { message: "secret provider detail" } }),
      },
    };

    // When the transcript fetch completes with the SDK error branch.
    const snapshot = await fetchSessionContext({
      client,
      parentSessionID: "parent-session",
      canonicalDirectory: "/workspace",
      limit: 4,
      signal: new AbortController().signal,
    });

    // Then no provider text or transcript content escapes the fixed status code.
    expect(snapshot).toEqual({
      reviewer: { status: "unavailable", reason: "sdk_error" },
      authorizationMessages: [],
    });
    expect(JSON.stringify(snapshot)).not.toContain("secret provider detail");
  });

  test("returns disabled without an SDK client", async () => {
    // Given transcript context is configured but no root client is available.

    // When the fetch boundary receives no client.
    const snapshot = await fetchSessionContext({
      client: undefined,
      parentSessionID: "parent-session",
      canonicalDirectory: "/workspace",
      limit: 4,
      signal: new AbortController().signal,
    });

    // Then context is explicitly disabled with empty authorization state.
    expect(snapshot).toEqual({ reviewer: { status: "disabled" }, authorizationMessages: [] });
  });

  test("returns an available empty projection for an empty SDK response", async () => {
    // Given a root client whose session contains no messages.
    const client = { session: { messages: async () => ({ data: [] }) } };

    // When the parent transcript is fetched.
    const snapshot = await fetchSessionContext({
      client,
      parentSessionID: "parent-session",
      canonicalDirectory: "/workspace",
      limit: 4,
      signal: new AbortController().signal,
    });

    // Then emptiness remains distinguishable from disabled and unavailable states.
    expect(snapshot).toEqual({
      reviewer: { status: "available", messages: [] },
      authorizationMessages: [],
    });
  });

  test.each([
    ["pre-aborted signal", true, "timeout"],
    ["fractional limit", false, "limit_exceeded"],
  ] as const)("does not call the SDK for %s", async (_label, aborted, reason) => {
    // Given a client capture and an invalid pre-call boundary condition.
    let calls = 0;
    const client = { session: { messages: async () => { calls += 1; return { data: [] }; } } };
    const controller = new AbortController();
    if (aborted) controller.abort();

    // When transcript fetch evaluates the pre-call condition.
    const snapshot = await fetchSessionContext({
      client,
      parentSessionID: "parent-session",
      canonicalDirectory: "/workspace",
      limit: aborted ? 4 : 1.5,
      signal: controller.signal,
    });

    // Then it returns a fixed unavailable status without touching the SDK.
    expect(snapshot).toEqual({
      reviewer: { status: "unavailable", reason },
      authorizationMessages: [],
    });
    expect(calls).toBe(0);
  });

  test("maps an SDK timeout exception to the fixed timeout status", async () => {
    // Given a root client that throws a timeout exception with sensitive text.
    const client = {
      session: {
        messages: async () => {
          const error = new Error("secret timeout detail");
          error.name = "TimeoutError";
          throw error;
        },
      },
    };

    // When transcript fetch calls the SDK.
    const snapshot = await fetchSessionContext({
      client,
      parentSessionID: "parent-session",
      canonicalDirectory: "/workspace",
      limit: 4,
      signal: new AbortController().signal,
    });

    // Then only the timeout status crosses the trust boundary.
    expect(snapshot).toEqual({
      reviewer: { status: "unavailable", reason: "timeout" },
      authorizationMessages: [],
    });
    expect(JSON.stringify(snapshot)).not.toContain("secret timeout detail");
  });

  test.each([
    ["missing data", {}],
    ["non-object response", null],
    ["undefined data", { data: undefined }],
  ])("maps malformed SDK result shape: %s", async (_label, response) => {
    // Given a root client returning a malformed result envelope.
    const client = { session: { messages: async () => response } };

    // When transcript fetch validates the SDK result.
    const snapshot = await fetchSessionContext({
      client,
      parentSessionID: "parent-session",
      canonicalDirectory: "/workspace",
      limit: 4,
      signal: new AbortController().signal,
    });

    // Then no response content appears outside the fixed malformed status.
    expect(snapshot).toEqual({
      reviewer: { status: "unavailable", reason: "malformed" },
      authorizationMessages: [],
    });
  });
});
