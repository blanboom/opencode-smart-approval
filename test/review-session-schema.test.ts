import { describe, expect, test } from "bun:test";
import { validateCreatedReviewSession } from "../src/review-session-schema";
import {
  REVIEW_DIRECTORY,
  REVIEW_TITLE,
  validCreatedSession,
} from "./fixtures/opencode-review-fixtures";
import {
  MALFORMED_SOURCE_SESSION_CASES,
  nonCleanableSourceSessionCases,
  validSourceCreatedSession,
  validSourceSessionCases,
} from "./fixtures/opencode-session-fixtures";

const expectation = {
  projectID: "project-id",
  directory: REVIEW_DIRECTORY,
  parentID: "parent-session",
  title: REVIEW_TITLE,
};

describe("created approval child schema", () => {
  test("accepts the exact source-shaped child", () => {
    // Given a complete child session response for the owned create call.
    const input = validCreatedSession();

    // When the strict source boundary validates it.
    const result = validateCreatedReviewSession(input, expectation);

    // Then ownership is identified by the exact nonempty child ID.
    expect(result).toEqual({ ok: true, childID: "child-session" });
  });

  test.each([
    ["project", { projectID: "other" }],
    ["directory", { directory: "/other" }],
    ["parent", { parentID: "other" }],
    ["title", { title: "other" }],
    ["version", { version: "" }],
    ["created", { time: { created: Number.NaN, updated: 11 } }],
    ["updated", { time: { created: 12, updated: 11 } }],
    ["unknown", { unexpected: true }],
  ] as const)("rejects malformed %s while retaining exact cleanup ownership", (_label, override) => {
    // Given a nonempty owned ID with one malformed or mismatched field.
    const input = { ...validCreatedSession(), ...override };

    // When strict child validation fails.
    const result = validateCreatedReviewSession(input, expectation);

    // Then the exact ID remains available only for bounded cleanup.
    expect(result).toEqual({ ok: false, code: "invalid_session", cleanableID: "child-session" });
  });

  test.each(["", null, undefined])("does not invent cleanup ownership for empty ID %p", (id) => {
    // Given a create response without a nonempty exact ID.
    const input = { ...validCreatedSession(), id };

    // When validation fails.
    const result = validateCreatedReviewSession(input, expectation);

    // Then broad discovery cannot be used to clean it.
    expect(result).toEqual({ ok: false, code: "invalid_session" });
  });

  test.each(validSourceSessionCases())("accepts source Session.Info %s", (_label, input) => {
    // Given one legitimate pinned-source Session.Info shape or boundary.
    // When the strict child boundary validates it.
    const result = validateCreatedReviewSession(input, expectation);

    // Then the exact child ID becomes owned.
    expect(result).toEqual({ ok: true, childID: "child-session" });
  });

  test.each(MALFORMED_SOURCE_SESSION_CASES)("rejects malformed source Session.Info $label", ({ mutate }) => {
    // Given one malformed or ownership-mismatched source field with an exact nonempty child ID.
    const input = mutate(validSourceCreatedSession());

    // When the strict child boundary validates the complete object.
    const result = validateCreatedReviewSession(input, expectation);

    // Then only the exact ID remains available for bounded cleanup.
    expect(result).toEqual({ ok: false, code: "invalid_session", cleanableID: "child-session" });
  });

  test.each(nonCleanableSourceSessionCases())("keeps %s noncleanable", (_label, input) => {
    // Given malformed create data without an exact nonempty string ID.
    // When the strict child boundary validates it.
    const result = validateCreatedReviewSession(input, expectation);

    // Then it does not invent cleanup ownership.
    expect(result).toEqual({ ok: false, code: "invalid_session" });
  });
});
