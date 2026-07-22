import { describe, expect, test } from "bun:test";
import { projectTranscriptEnvelope } from "../src/transcript-projector";
import {
  assistantEntryFixture,
  CANONICAL_DIRECTORY,
  PARENT_SESSION_ID,
  textPartFixture,
  userEntryFixture,
} from "./fixtures/transcript-fixtures";

const project = (data: unknown, limit = 32) => projectTranscriptEnvelope({
  data,
  parentSessionID: PARENT_SESSION_ID,
  canonicalDirectory: CANONICAL_DIRECTORY,
  limit,
});

describe("transcript identity and shape failures", () => {
  test.each([
    ["tuple inversion", [
      userEntryFixture({ id: "newer", created: 20, parts: [textPartFixture({ id: "newer-part", messageID: "newer" })] }),
      userEntryFixture({ id: "older", created: 10, parts: [textPartFixture({ id: "older-part", messageID: "older" })] }),
    ]],
    ["tuple duplicate", [
      userEntryFixture({ id: "same", created: 10, parts: [textPartFixture({ id: "same-a", messageID: "same" })] }),
      userEntryFixture({ id: "same", created: 10, parts: [textPartFixture({ id: "same-b", messageID: "same" })] }),
    ]],
    ["same-time ID inversion", [
      userEntryFixture({ id: "z", created: 10, parts: [textPartFixture({ id: "z-part", messageID: "z" })] }),
      userEntryFixture({ id: "a", created: 10, parts: [textPartFixture({ id: "a-part", messageID: "a" })] }),
    ]],
  ] as const)("rejects source-order %s", (_label, entries) => {
    // Given entries that violate the pinned strict adjacent tuple invariant.
    // When the response projection validates source order.
    const snapshot = project(entries);

    // Then no transcript or authorization content is released.
    expect(snapshot).toEqual({
      reviewer: { status: "unavailable", reason: "order_mismatch" },
      authorizationMessages: [],
    });
  });

  test.each(["bad id", "colon:id", "a".repeat(129)])("rejects non-source message ID %s", (id) => {
    // Given an otherwise valid message with a forbidden or oversized ID.
    const entry = userEntryFixture({ id, parts: [textPartFixture({ id: "part", messageID: id })] });

    // When identity validation checks the source-locked ID grammar.
    const snapshot = project([entry]);

    // Then invalid identities fail closed.
    expect(snapshot).toEqual({
      reviewer: { status: "unavailable", reason: "identity_mismatch" },
      authorizationMessages: [],
    });
  });
  test.each([
    ["message session", { ...userEntryFixture(), info: { ...userEntryFixture().info, sessionID: "other" } }],
    ["assistant cwd", assistantEntryFixture({ cwd: "/other" })],
    ["part session", { ...userEntryFixture(), parts: [{ ...textPartFixture(), sessionID: "other" }] }],
    ["part message", { ...userEntryFixture(), parts: [{ ...textPartFixture(), messageID: "other" }] }],
  ])("rejects an identity mismatch in %s", (_label, entry) => {
    // Given one transcript entry with an identity field outside the parent boundary.

    // When the entry is projected.
    const snapshot = project([entry]);

    // Then it returns only the fixed identity mismatch status.
    expect(snapshot).toEqual({
      reviewer: { status: "unavailable", reason: "identity_mismatch" },
      authorizationMessages: [],
    });
  });

  test("rejects duplicate message and part identities", () => {
    // Given duplicate message IDs and duplicate part IDs in separate transcript variants.
    const duplicateMessage = [userEntryFixture(), userEntryFixture()];
    const duplicatePart = [userEntryFixture({ parts: [textPartFixture(), textPartFixture()] })];

    // When each variant is projected.
    const snapshots = [project(duplicateMessage), project(duplicatePart)];

    // Then identity validation fails closed before content is emitted.
    expect(snapshots.map((snapshot) => snapshot.reviewer)).toEqual([
      { status: "unavailable", reason: "order_mismatch" },
      { status: "unavailable", reason: "identity_mismatch" },
    ]);
    expect(snapshots.every((snapshot) => snapshot.authorizationMessages.length === 0)).toBe(true);
  });

  test.each([
    ["nonfinite created time", { ...userEntryFixture(), info: { ...userEntryFixture().info, time: { created: Number.NaN } } }],
    ["incomplete assistant", { ...assistantEntryFixture(), info: { ...assistantEntryFixture().info, cost: undefined } }],
    ["incomplete reasoning", assistantEntryFixture({ parts: [{ id: "bad", sessionID: PARENT_SESSION_ID, messageID: "message-assistant", type: "reasoning", text: "hidden" }] })],
  ])("rejects malformed SDK shape: %s", (_label, entry) => {
    // Given an SDK entry that violates the pinned message or part contract.

    // When strict boundary validation runs on the copied snapshot.
    const snapshot = project([entry]);

    // Then malformed content is not partially exposed.
    expect(snapshot).toEqual({
      reviewer: { status: "unavailable", reason: "malformed" },
      authorizationMessages: [],
    });
  });
});
