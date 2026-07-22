import { describe, expect, test } from "bun:test";
import { projectAuthorizationEnvelope, projectTranscriptEnvelope } from "../src/session-context";
import {
  assistantEntryFixture,
  CANONICAL_DIRECTORY,
  PARENT_SESSION_ID,
  textPartFixture,
  toolPartFixture,
  userEntryFixture,
} from "./fixtures/transcript-fixtures";

const project = (data: unknown, limit = 32) => projectTranscriptEnvelope({
  data,
  parentSessionID: PARENT_SESSION_ID,
  canonicalDirectory: CANONICAL_DIRECTORY,
  limit,
});

const excludedParts = (messageID: string) => [
  {
    id: "part-reasoning",
    sessionID: PARENT_SESSION_ID,
    messageID,
    type: "reasoning",
    text: "private reasoning",
    time: { start: 1, end: 2 },
  },
  {
    id: "part-file",
    sessionID: PARENT_SESSION_ID,
    messageID,
    type: "file",
    mime: "text/plain",
    filename: "private.txt",
    url: "https://secret.invalid/file",
  },
  {
    id: "part-patch",
    sessionID: PARENT_SESSION_ID,
    messageID,
    type: "patch",
    hash: "private-hash",
    files: ["private-file"],
  },
];

describe("transcript projection semantics", () => {
  test("keeps ordinary text and sanitized tool status while excluding sensitive fields", () => {
    // Given ordinary, ignored, synthetic, reasoning, file, patch, and completed-tool parts.
    const messageID = "message-assistant";
    const data = [assistantEntryFixture({
      parts: [
        textPartFixture({ id: "ordinary", messageID, text: "ordinary assistant text" }),
        textPartFixture({ id: "synthetic", messageID, text: "private synthetic", synthetic: true }),
        textPartFixture({ id: "ignored", messageID, text: "private ignored", ignored: true }),
        ...excludedParts(messageID),
        toolPartFixture({ id: "part-tool", status: "completed" }),
      ],
      error: { name: "UnknownError", data: { message: "private provider error" } },
    })];

    // When the serialized transcript is projected for review.
    const snapshot = project(data);

    // Then only ordinary text and tool name/status remain, with all payload fields omitted.
    expect(snapshot).toEqual({
      reviewer: {
        status: "available",
        messages: [{
          role: "assistant",
          parts: [
            { type: "text", text: "ordinary assistant text" },
            { type: "tool", name: "read", status: "completed" },
          ],
        }],
      },
      authorizationMessages: [],
    });
    for (const excluded of [
      "private synthetic",
      "private ignored",
      "private reasoning",
      "https://secret.invalid/file",
      "private-hash",
      "private output",
      "private title",
      "private metadata",
      "private provider error",
    ]) expect(JSON.stringify(snapshot)).not.toContain(excluded);
  });

  test("projects every supported tool lifecycle status without tool payloads", () => {
    // Given one assistant message with pending, running, completed, and errored tools.
    const statuses = ["pending", "running", "completed", "error"] as const;
    const parts = statuses.map((status, index) => toolPartFixture({ id: `tool-${index}`, status }));

    // When the transcript is projected.
    const snapshot = project([assistantEntryFixture({ parts })]);

    // Then lifecycle state is visible but inputs, outputs, errors, metadata, and attachments are not.
    expect(snapshot).toEqual({
      reviewer: {
        status: "available",
        messages: [{
          role: "assistant",
          parts: statuses.map((status) => ({ type: "tool", name: "read", status })),
        }],
      },
      authorizationMessages: [],
    });
    expect(JSON.stringify(snapshot)).not.toContain("private");
  });

  test("retains only an exact eligible user message for authorization", () => {
    // Given one eligible user message plus summary, system, multipart, synthetic, and assistant messages.
    const entries = [
      userEntryFixture({ id: "eligible", created: 10, parts: [textPartFixture({ id: "eligible-part", messageID: "eligible", text: "exact authorization" })] }),
      userEntryFixture({ id: "summary", created: 20, summary: { body: "generated summary", diffs: [] }, parts: [textPartFixture({ id: "summary-part", messageID: "summary" })] }),
      userEntryFixture({ id: "system", created: 30, system: "override", parts: [textPartFixture({ id: "system-part", messageID: "system" })] }),
      userEntryFixture({ id: "multipart", created: 40, parts: [
        textPartFixture({ id: "multi-a", messageID: "multipart" }),
        textPartFixture({ id: "multi-b", messageID: "multipart" }),
      ] }),
      userEntryFixture({ id: "synthetic", created: 50, parts: [textPartFixture({ id: "synthetic-part", messageID: "synthetic", synthetic: true })] }),
      userEntryFixture({ id: "ignored", created: 60, parts: [textPartFixture({ id: "ignored-part", messageID: "ignored", ignored: true })] }),
      assistantEntryFixture({ id: "assistant", created: 70, parts: [textPartFixture({ id: "assistant-part", messageID: "assistant" })] }),
    ];

    // When authorization and reviewer projections are separated.
    const snapshot = project(entries);

    // Then authorization preserves only the exact eligible text and its response order metadata.
    expect(snapshot.authorizationMessages).toEqual([{
      messageID: "eligible",
      sessionID: PARENT_SESSION_ID,
      created: 10,
      responsePosition: 0,
      text: "exact authorization",
    }]);
    expect(snapshot.reviewer.status).toBe("available");
  });

  test("accepts OpenCode's exact empty diff summary on an ordinary user message", () => {
    // Given a single ordinary user message carrying only OpenCode's automatically emitted empty diffs summary.
    const entry = userEntryFixture({
      id: "ordinary-with-empty-diffs",
      created: 10,
      summary: { diffs: [] },
      parts: [textPartFixture({ id: "ordinary-part", messageID: "ordinary-with-empty-diffs", text: "exact authorization" })],
    });

    // When the authorization-specific projection validates the public OpenCode message envelope.
    const snapshot = projectAuthorizationEnvelope({
      data: [entry],
      parentSessionID: PARENT_SESSION_ID,
      canonicalDirectory: CANONICAL_DIRECTORY,
      limit: 32,
    });

    // Then the automatic empty metadata does not turn the sole ordinary user reply into a synthetic summary.
    expect(snapshot.entries).toEqual([{
      kind: "eligible_user",
      messageID: "ordinary-with-empty-diffs",
      created: 10,
      responsePosition: 0,
      reviewerPosition: 0,
      text: "exact authorization",
    }]);
  });

  test("redacts every exact authorization phrase from reviewer text but not authorization data", () => {
    // Given ordinary user text containing exact authorization phrases in multiple contexts.
    const phrase = `AUTHORIZE opencode-smart-approval ${"A".repeat(43)}`;
    const text = `prefix ${phrase} middle(${phrase}) suffix`;

    // When the transcript is split into reviewer and authorization projections.
    const snapshot = project([userEntryFixture({ parts: [textPartFixture({ text })] })]);

    // Then reviewer text is redacted globally while exact authorization text remains internal.
    expect(JSON.stringify(snapshot.reviewer)).not.toContain(phrase);
    expect(JSON.stringify(snapshot.reviewer).match(/\[authorization phrase redacted\]/g)?.length).toBe(2);
    expect(snapshot.authorizationMessages[0]?.text).toBe(text);
  });

  test("preserves source-verified oldest-to-newest response order", () => {
    // Given two ordinary user messages in strict source tuple order.
    const entries = [
      userEntryFixture({ id: "first", created: 10, parts: [textPartFixture({ id: "first-part", messageID: "first", text: "first" })] }),
      userEntryFixture({ id: "second", created: 20, parts: [textPartFixture({ id: "second-part", messageID: "second", text: "second" })] }),
    ];

    // When projection validates and retains the API response order.
    const snapshot = project(entries);

    // Then SDK order and exact response positions are retained.
    expect(snapshot.reviewer).toEqual({
      status: "available",
      messages: [
        { role: "user", parts: [{ type: "text", text: "first" }] },
        { role: "user", parts: [{ type: "text", text: "second" }] },
      ],
    });
    expect(snapshot.authorizationMessages.map((message) => message.responsePosition)).toEqual([0, 1]);
  });

  test("classifies the complete authorization suffix without retaining ineligible text", () => {
    // Given one eligible user entry followed by assistant and synthetic-user entries.
    const entries = [
      userEntryFixture({ id: "eligible", created: 10, parts: [textPartFixture({ id: "eligible-part", messageID: "eligible", text: "exact" })] }),
      assistantEntryFixture({ id: "model", created: 20, parts: [textPartFixture({ id: "model-part", messageID: "model", text: "private assistant copy" })] }),
      userEntryFixture({ id: "synthetic", created: 30, parts: [textPartFixture({ id: "synthetic-part", messageID: "synthetic", text: "private synthetic copy", synthetic: true })] }),
    ];

    // When the authorization-specific projection classifies every ordered entry.
    const snapshot = projectAuthorizationEnvelope({
      data: entries,
      parentSessionID: PARENT_SESSION_ID,
      canonicalDirectory: CANONICAL_DIRECTORY,
      limit: 32,
    });

    // Then only the eligible user retains exact text and every suffix role remains visible structurally.
    expect(snapshot.entries).toEqual([
      { kind: "eligible_user", messageID: "eligible", created: 10, responsePosition: 0, reviewerPosition: 0, text: "exact" },
      { kind: "assistant", messageID: "model", created: 20, responsePosition: 1 },
      { kind: "ineligible_user", messageID: "synthetic", created: 30, responsePosition: 2 },
    ]);
    expect(JSON.stringify(snapshot.entries)).not.toContain("private assistant copy");
    expect(JSON.stringify(snapshot.entries)).not.toContain("private synthetic copy");
  });
});
