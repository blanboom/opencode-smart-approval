import { describe, expect, test } from "bun:test";
import {
  MAX_REVIEW_RESPONSE_ENVELOPE_UTF8_BYTES,
  MAX_REVIEW_RESPONSE_ORDINARY_TEXT_UTF8_BYTES,
  MAX_REVIEW_RESPONSE_PARTS,
  parseReviewPromptResponse,
} from "../src/review-response";
import { responseExpectation, validPromptResponse } from "./fixtures/opencode-review-fixtures";

describe("review prompt response bounds", () => {
  test("accepts one source-locked response and inherited runtime selection", () => {
    // Given fixed-model and inherited expectations for the same valid response.
    const response = validPromptResponse();

    // When both model branches validate the response.
    const fixed = parseReviewPromptResponse(response, responseExpectation("fixed"));
    const inherited = parseReviewPromptResponse(response, responseExpectation("inherited"));

    // Then the strict verdict is projected without transport fields.
    expect(fixed).toEqual({
      ok: true,
      value: {
        outcome: "allow", riskLevel: "low", userAuthorization: "unknown",
        categories: [{ id: "security.reviewed", score: 0.1 }], reasons: ["bounded command"],
      },
    });
    expect(inherited).toEqual(fixed);
  });

  test("rejects complete envelope serialization failure before traversal", () => {
    // Given a cyclic provider envelope.
    const response: Record<string, unknown> = validPromptResponse();
    response["cycle"] = response;

    // When the complete response is copied.
    const result = parseReviewPromptResponse(response, responseExpectation());

    // Then no nested content crosses the boundary.
    expect(result).toEqual({ ok: false, code: "malformed_envelope" });
  });

  test("enforces envelope, part-count, and ordinary-text byte caps", () => {
    // Given three independently oversized source-shaped responses.
    const envelope = { ...validPromptResponse(), padding: "x".repeat(MAX_REVIEW_RESPONSE_ENVELOPE_UTF8_BYTES) };
    const part = validPromptResponse().parts[1];
    if (!part) throw new Error("missing fixture part");
    const tooManyParts = { ...validPromptResponse(), parts: Array.from({ length: MAX_REVIEW_RESPONSE_PARTS + 1 }, () => part) };
    const oversizedText = validPromptResponse();
    const textPart = oversizedText.parts[1];
    if (!textPart || !("text" in textPart)) throw new Error("missing text fixture");
    textPart.text = "界".repeat(MAX_REVIEW_RESPONSE_ORDINARY_TEXT_UTF8_BYTES);

    // When each cap is evaluated.
    const results = [envelope, tooManyParts, oversizedText]
      .map((response) => parseReviewPromptResponse(response, responseExpectation()));

    // Then all limits fail with the stable limit classification.
    expect(results).toEqual(Array.from({ length: 3 }, () => ({ ok: false, code: "limit_exceeded" })));
  });
});
