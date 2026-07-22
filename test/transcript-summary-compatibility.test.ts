import { describe, expect, test } from "bun:test";
import { projectAuthorizationEnvelope } from "../src/session-context";
import {
  CANONICAL_DIRECTORY,
  PARENT_SESSION_ID,
  textPartFixture,
  userEntryFixture,
} from "./fixtures/transcript-fixtures";

const projectSummary = (summary: unknown) => projectAuthorizationEnvelope({
  data: [userEntryFixture({
    id: "summary-message",
    created: 10,
    summary,
    parts: [textPartFixture({ id: "summary-part", messageID: "summary-message", text: "authorization" })],
  })],
  parentSessionID: PARENT_SESSION_ID,
  canonicalDirectory: CANONICAL_DIRECTORY,
  limit: 32,
});

describe("OpenCode automatic summary compatibility", () => {
  test.each([
    ["title", { diffs: [], title: "generated title" }],
    ["body", { diffs: [], body: "generated body" }],
    ["nonempty diffs", {
      diffs: [{ file: "source.ts", before: "before", after: "after", additions: 1, deletions: 0 }],
    }],
    ["unknown field", { diffs: [], unexpected: true }],
  ] as const)("rejects a user summary containing %s from authorization eligibility", (_label, summary) => {
    // Given an ordinary user message whose summary is not OpenCode's exact automatic empty-diff shape.
    // When the authorization projection classifies the message.
    const snapshot = projectSummary(summary);

    // Then the transcript remains available but the summarized user message is ineligible.
    expect(snapshot).toEqual({
      reviewer: { status: "available", messages: [] },
      entries: [{
        kind: "ineligible_user",
        messageID: "summary-message",
        created: 10,
        responsePosition: 0,
      }],
    });
  });

  test.each([
    ["diffs", { diffs: "not-an-array" }],
    ["title", { diffs: [], title: 7 }],
    ["body", { diffs: [], body: false }],
  ] as const)("rejects a user summary with the wrong %s type as malformed", (_label, summary) => {
    // Given an ordinary user message whose summary violates the public OpenCode message schema.
    // When the authorization projection parses the message envelope.
    const snapshot = projectSummary(summary);

    // Then malformed external input fails closed without retaining an authorization entry.
    expect(snapshot).toEqual({
      reviewer: { status: "unavailable", reason: "malformed" },
      entries: [],
    });
  });
});
