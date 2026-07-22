import { describe, expect, test } from "bun:test";
import {
  fetchSessionContextWithAdapter,
  MAX_TRANSCRIPT_ENVELOPE_UTF8_BYTES,
} from "../src/session-context";
import { createOpenCodeClientAdapter } from "../src/opencode-client-adapter";
import {
  CANONICAL_DIRECTORY,
  PARENT_SESSION_ID,
  userEntryFixture,
} from "./fixtures/transcript-fixtures";
import { fakeClient } from "./fixtures/opencode-client-fake";

const serializedBytes = (value: unknown): number => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("fixture is not serializable");
  return new TextEncoder().encode(serialized).byteLength;
};

const fetchResponse = async (response: unknown) => {
  const fake = fakeClient(async (method) => method === "messages" ? response : { data: true });
  return fetchSessionContextWithAdapter({
    adapter: createOpenCodeClientAdapter(fake.client),
    parentSessionID: PARENT_SESSION_ID,
    canonicalDirectory: CANONICAL_DIRECTORY,
    limit: 8,
    signal: new AbortController().signal,
  });
};

const wrapperAtUtf8Bytes = (targetBytes: number): unknown => {
  const emptyPadding = { data: [userEntryFixture()], excludedPadding: "" };
  const baseBytes = serializedBytes(emptyPadding);
  const response = {
    data: [userEntryFixture()],
    excludedPadding: "x".repeat(targetBytes - baseBytes),
  };
  expect(serializedBytes(response)).toBe(targetBytes);
  return response;
};

const errorWrapperAtUtf8Bytes = (targetBytes: number): unknown => {
  const emptyPadding = { error: { message: "" } };
  const baseBytes = serializedBytes(emptyPadding);
  const response = { error: { message: "x".repeat(targetBytes - baseBytes) } };
  expect(serializedBytes(response)).toBe(targetBytes);
  return response;
};

describe("complete SDK wrapper serialization boundary", () => {
  test.each([
    MAX_TRANSCRIPT_ENVELOPE_UTF8_BYTES - 1,
    MAX_TRANSCRIPT_ENVELOPE_UTF8_BYTES,
  ])("accepts a complete wrapper at %i UTF-8 bytes", async (targetBytes) => {
    // Given a valid SDK wrapper with an excluded top-level field at the byte boundary.
    const response = wrapperAtUtf8Bytes(targetBytes);

    // When fetch serializes the complete returned wrapper before validation.
    const snapshot = await fetchResponse(response);

    // Then the bounded wrapper is accepted and excluded content is omitted.
    expect(snapshot.reviewer.status).toBe("available");
    expect(JSON.stringify(snapshot)).not.toContain("excludedPadding");
  });

  test("rejects a complete wrapper one UTF-8 byte above the cap", async () => {
    // Given a valid data array hidden inside an oversized SDK wrapper.
    const response = wrapperAtUtf8Bytes(MAX_TRANSCRIPT_ENVELOPE_UTF8_BYTES + 1);

    // When the complete returned wrapper is preflighted.
    const snapshot = await fetchResponse(response);

    // Then unknown wrapper fields cannot bypass the envelope limit.
    expect(snapshot).toEqual({
      reviewer: { status: "unavailable", reason: "limit_exceeded" },
      authorizationMessages: [],
    });
  });

  test.each([
    ["undefined", undefined],
    ["BigInt", { data: [userEntryFixture()], excluded: 1n }],
  ])("rejects a non-JSON %s wrapper as malformed", async (_label, response) => {
    // Given a complete SDK return value that JSON cannot serialize.

    // When the wrapper preflight runs.
    const snapshot = await fetchResponse(response);

    // Then serialization failure emits only the deterministic malformed status.
    expect(snapshot).toEqual({
      reviewer: { status: "unavailable", reason: "malformed" },
      authorizationMessages: [],
    });
  });

  test("rejects a cyclic complete wrapper as malformed", async () => {
    // Given a cyclic top-level SDK wrapper with otherwise valid data.
    const response: { data: readonly unknown[]; self?: unknown } = { data: [userEntryFixture()] };
    response.self = response;

    // When the wrapper preflight runs.
    const snapshot = await fetchResponse(response);

    // Then the cycle cannot be ignored by validating only data.
    expect(snapshot).toEqual({
      reviewer: { status: "unavailable", reason: "malformed" },
      authorizationMessages: [],
    });
  });

  test("invokes complete-wrapper toJSON exactly once before structural validation", async () => {
    // Given a wrapper whose serialization contract is observable.
    let toJsonCalls = 0;
    const response = {
      data: [userEntryFixture({ id: "must-not-be-read" })],
      toJSON: () => {
        toJsonCalls += 1;
        return { data: [userEntryFixture()] };
      },
    };

    // When fetch copies and validates the wrapper.
    const snapshot = await fetchResponse(response);

    // Then only the one serialized snapshot is used.
    expect(snapshot.reviewer.status).toBe("available");
    expect(toJsonCalls).toBe(1);
  });

  test("never reads original fields when toJSON supplies the serialized snapshot", async () => {
    // Given a wrapper with a throwing original data getter and a safe toJSON snapshot.
    let directDataReads = 0;
    const response = {
      get data(): unknown {
        directDataReads += 1;
        throw new Error("original data getter traversed");
      },
      toJSON: () => ({ data: [userEntryFixture()] }),
    };

    // When complete-wrapper serialization precedes schema validation.
    const snapshot = await fetchResponse(response);

    // Then validation consumes only the parsed copy, never the getter-bearing original.
    expect(snapshot.reviewer.status).toBe("available");
    expect(directDataReads).toBe(0);
  });

  test("does not traverse nested original getters after the serialized copy", async () => {
    // Given nested message data that throws if read more than once.
    const entry = userEntryFixture();
    let identityReads = 0;
    Object.defineProperty(entry.info, "id", {
      enumerable: true,
      get: () => {
        identityReads += 1;
        if (identityReads > 1) throw new Error("original identity read twice");
        return "message-user";
      },
    });

    // When fetch snapshots and projects the wrapper.
    const snapshot = await fetchResponse({ data: [entry] });

    // Then the original nested getter is consumed only by JSON.stringify.
    expect(snapshot.reviewer.status).toBe("available");
    expect(identityReads).toBe(1);
  });

  test("maps a throwing toJSON implementation to malformed", async () => {
    // Given a wrapper whose serialization hook throws sensitive details.
    const response = { toJSON: () => { throw new Error("secret serialization detail"); } };

    // When fetch performs the complete-wrapper preflight.
    const snapshot = await fetchResponse(response);

    // Then the detail is discarded and no structural validation runs.
    expect(snapshot).toEqual({
      reviewer: { status: "unavailable", reason: "malformed" },
      authorizationMessages: [],
    });
    expect(JSON.stringify(snapshot)).not.toContain("secret serialization detail");
  });

  test("returns sdk_error only after a successful bounded wrapper copy", async () => {
    // Given a serializable in-cap SDK error wrapper.
    const response = { error: { message: "secret provider detail" } };

    // When fetch copies and validates the complete wrapper.
    const snapshot = await fetchResponse(response);

    // Then the provider detail is reduced to the fixed SDK status.
    expect(snapshot).toEqual({
      reviewer: { status: "unavailable", reason: "sdk_error" },
      authorizationMessages: [],
    });
    expect(JSON.stringify(snapshot)).not.toContain("secret provider detail");
  });

  test("gives wrapper overflow precedence over sdk_error", async () => {
    // Given an SDK error wrapper one byte above the complete envelope cap.
    const response = errorWrapperAtUtf8Bytes(MAX_TRANSCRIPT_ENVELOPE_UTF8_BYTES + 1);

    // When fetch preflights the complete wrapper.
    const snapshot = await fetchResponse(response);

    // Then size rejection occurs before SDK error classification.
    expect(snapshot).toEqual({
      reviewer: { status: "unavailable", reason: "limit_exceeded" },
      authorizationMessages: [],
    });
  });
});
