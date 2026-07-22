import { describe, expect, test } from "bun:test";
import { projectTranscriptEnvelope } from "../src/session-context";
import {
  assistantEntryFixture,
  CANONICAL_DIRECTORY,
  PARENT_SESSION_ID,
  textPartFixture,
  toolPartFixture,
  userEntryFixture,
} from "./fixtures/transcript-fixtures";

const oversizedSecret = (label: string): string => `SENSITIVE_${label}_${"x".repeat(2_100)}`;

const project = (data: unknown) => projectTranscriptEnvelope({
  data,
  parentSessionID: PARENT_SESSION_ID,
  canonicalDirectory: CANONICAL_DIRECTORY,
  limit: 16,
});

describe("transcript excluded provider fields", () => {
  test("does not apply emitted-content caps to excluded fields or copy their contents", () => {
    // Given valid messages with oversized content in every excluded provider-controlled field class.
    const completedTool = toolPartFixture({ id: "completed-tool", status: "completed" });
    const errorTool = toolPartFixture({ id: "error-tool", status: "error" });
    const completedState = {
      ...completedTool.state,
      input: { secret: oversizedSecret("input") },
      output: oversizedSecret("output"),
      title: oversizedSecret("title"),
      metadata: { secret: oversizedSecret("metadata") },
      attachments: [{
        id: "attachment",
        sessionID: PARENT_SESSION_ID,
        messageID: "message-assistant",
        type: "file",
        mime: "text/plain",
        url: oversizedSecret("attachment-url"),
      }],
    };
    const errorState = { ...errorTool.state, error: oversizedSecret("tool-error") };
    const entries = [
      userEntryFixture({
        id: "summary",
        created: 10,
        summary: { body: oversizedSecret("summary"), diffs: [] },
        parts: [textPartFixture({ id: "summary-text", messageID: "summary", text: oversizedSecret("summary-text") })],
      }),
      userEntryFixture({
        id: "system",
        created: 20,
        system: oversizedSecret("system"),
        parts: [textPartFixture({ id: "system-text", messageID: "system", text: "ordinary system-overridden text" })],
      }),
      userEntryFixture({
        id: "synthetic",
        created: 30,
        parts: [textPartFixture({ id: "synthetic-text", messageID: "synthetic", text: oversizedSecret("synthetic"), synthetic: true })],
      }),
      assistantEntryFixture({
        created: 40,
        error: {
          name: "APIError",
          data: { message: oversizedSecret("provider-error"), isRetryable: false, responseBody: oversizedSecret("response-body") },
        },
        parts: [
          {
            id: "reasoning",
            sessionID: PARENT_SESSION_ID,
            messageID: "message-assistant",
            type: "reasoning",
            text: oversizedSecret("reasoning"),
            time: { start: 1 },
          },
          { ...completedTool, state: completedState },
          { ...errorTool, state: errorState },
        ],
      }),
    ];

    // When the complete envelope remains below the byte cap and is projected.
    const snapshot = project(entries);

    // Then excluded values neither trip emitted text caps nor appear in either projection.
    expect(snapshot.reviewer.status).toBe("available");
    expect(JSON.stringify(snapshot)).not.toContain("SENSITIVE_");
    expect(snapshot.authorizationMessages).toEqual([]);
  });

  test("validates nested attachment identity without exposing attachment content", () => {
    // Given a completed tool attachment bound to a different parent session.
    const tool = toolPartFixture({ id: "completed-tool", status: "completed" });
    const state = {
      ...tool.state,
      attachments: [{
        id: "attachment",
        sessionID: "other-session",
        messageID: "message-assistant",
        type: "file",
        mime: "text/plain",
        url: "private attachment",
      }],
    };

    // When every part identity is checked after the serialized copy.
    const snapshot = project([assistantEntryFixture({ parts: [{ ...tool, state }] })]);

    // Then the mismatch fails closed with zero transcript content.
    expect(snapshot).toEqual({
      reviewer: { status: "unavailable", reason: "identity_mismatch" },
      authorizationMessages: [],
    });
  });
});
