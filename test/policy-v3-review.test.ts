import { describe, expect, test } from "bun:test";
import { policyFromUnknown } from "../src/policy-parser";

const parseReview = (review: unknown) => policyFromUnknown({ version: 3, review }, []);

const expectReviewFailure = (review: unknown, field: string): void => {
  expect(() => parseReview(review)).toThrow(`review.${field}`);
};

describe("policy v3 review contract", () => {
  test("applies every review default without inventing model or prompt", () => {
    // Given the required empty v3 review object.
    // When the strict policy boundary resolves it.
    const review = parseReview({}).review;

    // Then only the documented defaults are supplied.
    expect(review).toEqual({
      timeoutMs: 45_000,
      contextMessages: 20,
      cleanupSession: true,
    });
    expect(Object.hasOwn(review, "model")).toBe(false);
    expect(Object.hasOwn(review, "prompt")).toBe(false);
  });

  test.each([
    ["minimum", 1_000],
    ["maximum", 300_000],
  ])("accepts the timeout %s", (_label, timeoutMs) => {
    // Given a timeout exactly on a documented edge.
    // When it is parsed.
    const review = parseReview({ timeout_ms: timeoutMs }).review;

    // Then the exact value reaches the runtime contract.
    expect(review.timeoutMs).toBe(timeoutMs);
  });

  test.each([
    ["below minimum", 999],
    ["above maximum", 300_001],
    ["fractional", 1_000.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["string", "45000"],
    ["null", null],
  ])("rejects a timeout that is %s", (_label, timeoutMs) => {
    // Given an invalid present timeout.
    // When/Then it fails rather than defaulting.
    expectReviewFailure({ timeout_ms: timeoutMs }, "timeout_ms");
  });

  test.each([
    ["minimum", 0],
    ["maximum", 200],
  ])("accepts the context message %s", (_label, contextMessages) => {
    // Given a context limit exactly on a documented edge.
    // When it is parsed.
    const review = parseReview({ context_messages: contextMessages }).review;

    // Then the exact value is retained, including zero as disabled.
    expect(review.contextMessages).toBe(contextMessages);
  });

  test.each([
    ["below minimum", -1],
    ["above maximum", 201],
    ["fractional", 1.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["string", "20"],
    ["null", null],
  ])("rejects a context message limit that is %s", (_label, contextMessages) => {
    // Given an invalid present context limit.
    // When/Then it fails rather than defaulting.
    expectReviewFailure({ context_messages: contextMessages }, "context_messages");
  });

  test.each([
    "provider/model",
    "provider/family/reviewer",
    "provider/model:latest",
  ])("accepts an exact provider/model identity %s", (model) => {
    // Given a trimmed provider/model identity with an optional slash-bearing remainder.
    // When it is parsed.
    const review = parseReview({ model }).review;

    // Then the exact identity is preserved.
    expect(review.model).toBe(model);
  });

  test.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["leading whitespace", " provider/model"],
    ["trailing whitespace", "provider/model "],
    ["missing slash", "provider"],
    ["missing provider", "/model"],
    ["missing model", "provider/"],
    ["provider whitespace", "pro vider/model"],
    ["model whitespace", "provider/mo del"],
    ["number", 3],
    ["null", null],
  ])("rejects a present model that is %s", (_label, model) => {
    // Given an invalid present model.
    // When/Then no absent-model fallback masks it.
    expectReviewFailure({ model }, "model");
  });

  test("accepts an exact trimmed prompt at the UTF-16 limit", () => {
    // Given a prompt occupying exactly 8,192 UTF-16 code units.
    const prompt = "x".repeat(8_192);

    // When it is parsed.
    const review = parseReview({ prompt }).review;

    // Then its exact contents are retained.
    expect(review.prompt).toBe(prompt);
  });

  test.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["leading whitespace", " guidance"],
    ["trailing whitespace", "guidance "],
    ["over limit", "x".repeat(8_193)],
    ["number", 3],
    ["null", null],
  ])("rejects a present prompt that is %s", (_label, prompt) => {
    // Given an invalid present prompt.
    // When/Then it fails rather than disappearing into the default.
    expectReviewFailure({ prompt }, "prompt");
  });

  test.each([true, false])("accepts cleanup_session=%s", (cleanupSession) => {
    // Given an explicit cleanup choice.
    // When it is parsed.
    const review = parseReview({ cleanup_session: cleanupSession }).review;

    // Then the exact boolean reaches the runtime contract.
    expect(review.cleanupSession).toBe(cleanupSession);
  });

  test.each(["true", 1, null])("rejects non-boolean cleanup_session %p", (cleanupSession) => {
    // Given a non-boolean present cleanup value.
    // When/Then it fails rather than coercing.
    expectReviewFailure({ cleanup_session: cleanupSession }, "cleanup_session");
  });
});
