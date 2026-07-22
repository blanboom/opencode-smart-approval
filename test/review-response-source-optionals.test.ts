import { describe, expect, test } from "bun:test";
import { parseReviewPromptResponse } from "../src/review-response";
import { invalidSourceResponseCases } from "./fixtures/opencode-response-source";
import {
  allowVerdict,
  responseExpectation,
  sourceCompletePromptResponse,
  validPromptResponse,
  validStepFinishPart,
} from "./fixtures/opencode-review-fixtures";

const conflictingVerdict = { ...allowVerdict(), outcome: "deny", reasons: ["untrusted optional branch"] };

const SOURCE_VALID_OPTIONALS = [
  ["assistant tokens.total", () => {
    const response = validPromptResponse();
    return { ...response, info: { ...response.info, tokens: { ...response.info.tokens, total: 3 } } };
  }],
  ["assistant structured", () => {
    const response = validPromptResponse();
    return { ...response, info: { ...response.info, structured: conflictingVerdict } };
  }],
  ["assistant variant", () => {
    const response = validPromptResponse();
    return { ...response, info: { ...response.info, variant: JSON.stringify(conflictingVerdict) } };
  }],
  ["step-finish tokens.total", () => {
    const response = validPromptResponse();
    return { ...response, parts: [...response.parts.slice(0, -1), validStepFinishPart(3)] };
  }],
] as const;

const allowResult = {
  ok: true,
  value: {
    outcome: "allow", riskLevel: "low", userAuthorization: "unknown",
    categories: [{ id: "security.reviewed", score: 0.1 }], reasons: ["bounded command"],
  },
} as const;

describe("pinned source response optionals", () => {
  test.each(SOURCE_VALID_OPTIONALS)("accepts source-valid %s without treating it as verdict text", (_label, response) => {
    // Given one pinned MessageV2 or StepFinish optional containing non-verdict data.
    // When the one-shot strict parser evaluates the complete response envelope.
    const result = parseReviewPromptResponse(response(), responseExpectation());

    // Then only the ordinary text part supplies the unchanged allow verdict.
    expect(result).toEqual(allowResult);
  });

  test("accepts every source-valid optional and ignored branch together", () => {
    // Given one source response combining totals, structured, variant, reasoning, and terminal tool fields.
    // When strict parsing consumes the copied JSON-safe envelope exactly once.
    const result = parseReviewPromptResponse(sourceCompletePromptResponse(), responseExpectation());

    // Then conflicting non-text branches cannot replace the ordinary allow verdict.
    expect(result).toEqual(allowResult);
  });

  test("accepts the exact empty optional variant string", () => {
    // Given the pinned optional variant is present at its empty-string boundary.
    const response = validPromptResponse();

    // When the strict parser evaluates the exact source string contract.
    const result = parseReviewPromptResponse({ ...response, info: { ...response.info, variant: "" } }, responseExpectation());

    // Then it remains non-verdict metadata and ordinary text still allows.
    expect(result).toEqual(allowResult);
  });

  test.each(invalidSourceResponseCases())("rejects malformed source response %s", (_label, response) => {
    // Given one malformed, incomplete, unsupported, or non-JSON source response.
    // When the strict one-shot parser evaluates the complete copied envelope.
    const result = parseReviewPromptResponse(response(), responseExpectation());

    // Then no invalid optional or neighboring source branch can authorize.
    expect(result).toEqual({ ok: false, code: "malformed_envelope" });
  });
});
