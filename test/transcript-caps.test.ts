import { describe, expect, test } from "bun:test";
import {
  MAX_TRANSCRIPT_PARTS_PER_MESSAGE,
  MAX_TRANSCRIPT_TEXT_CHARS_PER_PART,
  MAX_TRANSCRIPT_TOOL_NAME_CHARS,
  MAX_TRANSCRIPT_TOTAL_CHARS,
  MAX_TRANSCRIPT_TOTAL_PARTS,
  projectTranscriptEnvelope,
} from "../src/session-context";
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

const emptyTextParts = (messageID: string, count: number) => Array.from(
  { length: count },
  (_unused, index) => textPartFixture({ id: `${messageID}-part-${index}`, messageID, text: "" }),
);

const userWithParts = (index: number, count: number) => {
  const id = `message-${index}`;
  return userEntryFixture({ id, parts: emptyTextParts(id, count) });
};

describe("transcript projection capacity limits", () => {
  test("accepts the configured message count and rejects one additional message", () => {
    // Given two valid messages and a one-message response limit.
    const entries = [userWithParts(0, 1), userWithParts(1, 1)];

    // When the boundary projects the exact and over-limit variants.
    const exact = project(entries.slice(0, 1), 1);
    const over = project(entries, 1);

    // Then the exact variant is available and the extra message fails closed.
    expect(exact.reviewer.status).toBe("available");
    expect(over.reviewer).toEqual({ status: "unavailable", reason: "limit_exceeded" });
  });

  test("accepts the per-message part cap and rejects one additional part", () => {
    // Given messages at and one above the per-message structural part cap.
    const exactEntry = userWithParts(0, MAX_TRANSCRIPT_PARTS_PER_MESSAGE);
    const overEntry = userWithParts(1, MAX_TRANSCRIPT_PARTS_PER_MESSAGE + 1);

    // When both variants are projected.
    const exact = project([exactEntry]);
    const over = project([overEntry]);

    // Then only the over-limit variant is rejected.
    expect(exact.reviewer.status).toBe("available");
    expect(over.reviewer).toEqual({ status: "unavailable", reason: "limit_exceeded" });
  });

  test("accepts the total structural part cap and rejects one additional part", () => {
    // Given eight full messages at 256 parts and a ninth message carrying part 257.
    const fullMessages = Array.from({ length: 8 }, (_unused, index) => userWithParts(index, 32));
    const overMessages = [...fullMessages, userWithParts(8, 1)];

    // When exact and over-limit transcripts are projected.
    const exact = project(fullMessages, 8);
    const over = project(overMessages, 9);

    // Then structural counting includes every part regardless of emitted content.
    expect(MAX_TRANSCRIPT_TOTAL_PARTS).toBe(256);
    expect(exact.reviewer.status).toBe("available");
    expect(over.reviewer).toEqual({ status: "unavailable", reason: "limit_exceeded" });
  });

  test("accepts the per-part text cap and rejects one additional character", () => {
    // Given ordinary text at and one character above the per-part cap.
    const exactText = "x".repeat(MAX_TRANSCRIPT_TEXT_CHARS_PER_PART);
    const overText = `${exactText}x`;

    // When both text variants are projected.
    const exact = project([userEntryFixture({ parts: [textPartFixture({ text: exactText })] })]);
    const over = project([userEntryFixture({ parts: [textPartFixture({ text: overText })] })]);

    // Then exact text remains available and the extra character rejects all content.
    expect(exact.reviewer.status).toBe("available");
    expect(over.reviewer).toEqual({ status: "unavailable", reason: "limit_exceeded" });
  });

  test("accepts the total emitted character cap and rejects one additional character", () => {
    // Given ten maximum text messages and an eleventh single-character message.
    const exactEntries = Array.from({ length: 10 }, (_unused, index) => {
      const id = `message-${index}`;
      return userEntryFixture({
        id,
        parts: [textPartFixture({ id: `part-${index}`, messageID: id, text: "x".repeat(2_000) })],
      });
    });
    const overEntries = [...exactEntries, userEntryFixture({
      id: "message-extra",
      parts: [textPartFixture({ id: "part-extra", messageID: "message-extra", text: "x" })],
    })];

    // When exact and over-limit transcripts are projected.
    const exact = project(exactEntries, 10);
    const over = project(overEntries, 11);

    // Then 20,000 emitted characters are accepted and 20,001 are rejected.
    expect(MAX_TRANSCRIPT_TOTAL_CHARS).toBe(20_000);
    expect(exact.reviewer.status).toBe("available");
    expect(over.reviewer).toEqual({ status: "unavailable", reason: "limit_exceeded" });
  });

  test("accepts the tool-name cap and rejects one additional character", () => {
    // Given completed tools with names at and one character above the cap.
    const exactPart = toolPartFixture({ id: "exact-tool", name: "t".repeat(MAX_TRANSCRIPT_TOOL_NAME_CHARS), status: "completed" });
    const overPart = toolPartFixture({ id: "over-tool", name: "t".repeat(MAX_TRANSCRIPT_TOOL_NAME_CHARS + 1), status: "completed" });

    // When both tool variants are projected.
    const exact = project([assistantEntryFixture({ parts: [exactPart] })]);
    const over = project([assistantEntryFixture({ parts: [overPart] })]);

    // Then only the oversized tool name rejects the projection.
    expect(exact.reviewer.status).toBe("available");
    expect(over.reviewer).toEqual({ status: "unavailable", reason: "limit_exceeded" });
  });
});
