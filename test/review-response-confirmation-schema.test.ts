import { describe, expect, test } from "bun:test";
import { parseReviewPromptResponse } from "../src/review-response";
import {
  allowVerdict,
  responseExpectation,
  validPromptResponse,
} from "./fixtures/opencode-review-fixtures";

const confirmationVerdict = (confirmation: Readonly<Record<string, unknown>> = {
  action: "Upload the current patch",
  data: "Git diff for src/index.ts",
  destination: "api.example.test review endpoint",
  risk: "The patch leaves the workstation",
}) => ({
  outcome: "needs_confirmation",
  risk_level: "high",
  user_authorization: "unknown",
  categories: [{ id: "security.external-disclosure", score: 0.9 }],
  reasons: ["Explicit consent is required"],
  confirmation,
});

describe("review prompt source schema", () => {
  test("accepts the strict needs_confirmation branch without mutating disclosure fields", () => {
    // Given a confirmation response with concrete non-normalized Unicode disclosure fields.
    const confirmation = {
      action: "Upload e\u0301 patch",
      data: "Diff for src/index.ts",
      destination: "review.example.test",
      risk: "Source leaves the device",
    };

    // When the strict reviewer response parser validates the branch.
    const result = parseReviewPromptResponse(validPromptResponse(confirmationVerdict(confirmation)), responseExpectation());

    // Then the exact code points survive in the discriminated response.
    expect(result).toEqual({ ok: true, value: {
      outcome: "needs_confirmation",
      riskLevel: "high",
      userAuthorization: "unknown",
      categories: [{ id: "security.external-disclosure", score: 0.9 }],
      reasons: ["Explicit consent is required"],
      confirmation,
    } });
  });

  test.each([
    ["allow confirmation", { ...allowVerdict(), confirmation: confirmationVerdict().confirmation }],
    ["deny confirmation", { ...allowVerdict(), outcome: "deny", confirmation: confirmationVerdict().confirmation }],
    ["missing confirmation", { ...confirmationVerdict(), confirmation: undefined }],
    ["unknown confirmation field", confirmationVerdict({
      action: "Upload patch", data: "Git diff", destination: "review endpoint", risk: "External disclosure", extra: "no",
    })],
  ] as const)("rejects %s branch ambiguity", (_label, verdict) => {
    // Given an outcome whose confirmation member does not match its discriminant.
    // When the strict response parser validates the union.
    const result = parseReviewPromptResponse(validPromptResponse(verdict), responseExpectation());

    // Then the ambiguous branch is rejected rather than repaired.
    expect(result).toEqual({ ok: false, code: "invalid_verdict" });
  });

  test.each([
    ["leading whitespace", "action", " Upload patch"],
    ["trailing whitespace", "data", "Git diff "],
    ["only punctuation", "destination", "!@#"],
    ["common placeholder", "risk", "UNKNOWN"],
    ["action placeholder", "action", "Do Something"],
    ["data placeholder", "data", "User Data"],
    ["destination placeholder", "destination", "INTERNET"],
    ["risk placeholder", "risk", "Potential Risk"],
    ["lone high surrogate", "action", "Upload \ud800"],
    ["lone low surrogate", "action", "Upload \udfff"],
    ["lone high surrogate", "data", "Data \ud800"],
    ["lone low surrogate", "data", "Data \udfff"],
    ["lone high surrogate", "destination", "Endpoint \ud800"],
    ["lone low surrogate", "destination", "Endpoint \udfff"],
    ["lone high surrogate", "risk", "Risk \ud800"],
    ["lone low surrogate", "risk", "Risk \udfff"],
    ["field over byte limit", "destination", `a${"界".repeat(342)}`],
  ] as const)("rejects confirmation %s in %s", (_label, field, value) => {
    // Given one invalid confirmation field and three concrete peers.
    const confirmation = { ...confirmationVerdict().confirmation, [field]: value };

    // When the structural boundary validates the field.
    const result = parseReviewPromptResponse(validPromptResponse(confirmationVerdict(confirmation)), responseExpectation());

    // Then invalid Unicode, trim, placeholder, and byte cases fail closed.
    expect(result).toEqual({ ok: false, code: "invalid_verdict" });
  });

  test.each([
    "unknown", "n/a", "na", "none", "null", "unspecified", "not specified", "tbd",
    "to be determined", "placeholder", "?", "-", "...",
  ])("rejects the complete common placeholder %s with ASCII-only case folding", (placeholder) => {
    // Given one exact whole-field common placeholder with alternating ASCII case.
    const folded = [...placeholder].map((character, index) => index % 2 === 0 ? character.toUpperCase() : character).join("");
    const confirmation = { ...confirmationVerdict().confirmation, risk: folded };

    // When the structural confirmation boundary computes its comparison key.
    const result = parseReviewPromptResponse(validPromptResponse(confirmationVerdict(confirmation)), responseExpectation());

    // Then every common placeholder is rejected without locale folding or mutation.
    expect(result).toEqual({ ok: false, code: "invalid_verdict" });
  });

  test.each([
    ["action", "action"], ["action", "do it"], ["action", "do something"], ["action", "perform action"],
    ["data", "data"], ["data", "some data"], ["data", "user data"], ["data", "information"], ["data", "something"],
    ["destination", "destination"], ["destination", "somewhere"], ["destination", "remote"],
    ["destination", "external"], ["destination", "external service"], ["destination", "internet"],
    ["risk", "risk"], ["risk", "some risk"], ["risk", "unknown risk"], ["risk", "may be risky"], ["risk", "potential risk"],
  ] as const)("rejects field-specific %s placeholder %s", (field, placeholder) => {
    // Given every exact field-specific placeholder in turn.
    const confirmation = { ...confirmationVerdict().confirmation, [field]: placeholder };

    // When the matching field schema validates the complete value.
    const result = parseReviewPromptResponse(validPromptResponse(confirmationVerdict(confirmation)), responseExpectation());

    // Then each named placeholder is rejected structurally.
    expect(result).toEqual({ ok: false, code: "invalid_verdict" });
  });

  test("uses no Unicode normalization or locale-aware case folding", () => {
    // Given decomposed Unicode and a non-ASCII uppercase character resembling a placeholder.
    const confirmation = {
      action: "Upload e\u0301 patch",
      data: "Git diff for src/index.ts",
      destination: "İNTERNET",
      risk: "Source leaves the device",
    };

    // When the exact code-point values cross the response boundary.
    const result = parseReviewPromptResponse(validPromptResponse(confirmationVerdict(confirmation)), responseExpectation());

    // Then both values survive exactly because only ASCII A-Z contributes to the comparison key.
    expect(result.ok && result.value.outcome === "needs_confirmation" && result.value.confirmation).toEqual(confirmation);
  });

  test("accepts the exact 4096-byte confirmation aggregate", () => {
    // Given four distinct concrete fields of exactly 1024 ASCII bytes each.
    const confirmation = {
      action: `A${"a".repeat(1_023)}`,
      data: `D${"d".repeat(1_023)}`,
      destination: `E${"e".repeat(1_023)}`,
      risk: `R${"r".repeat(1_023)}`,
    };

    // When the aggregate byte boundary validates the response.
    const result = parseReviewPromptResponse(validPromptResponse(confirmationVerdict(confirmation)), responseExpectation());

    // Then the exact limit is accepted without changing any field.
    expect(result.ok && result.value.outcome === "needs_confirmation" && result.value.confirmation).toEqual(confirmation);
  });

  test("enforces category and reason count and byte aggregates", () => {
    // Given responses just beyond each fixed collection or aggregate limit.
    const categories = Array.from({ length: 33 }, (_, index) => ({ id: `security.c${String(index)}`, score: 0.5 }));
    const reasons = Array.from({ length: 17 }, (_, index) => `reason-${String(index)}`);
    const aggregateReasons = Array.from({ length: 9 }, () => "r".repeat(1_024));

    // When the strict parser validates each response.
    const results = [categories, reasons, aggregateReasons].map((values, index) => parseReviewPromptResponse(
      validPromptResponse(index === 0
        ? { ...allowVerdict(), categories: values }
        : { ...allowVerdict(), reasons: values }),
      responseExpectation(),
    ));

    // Then no oversized collection or aggregate is accepted.
    expect(results).toEqual([
      { ok: false, code: "invalid_verdict" },
      { ok: false, code: "invalid_verdict" },
      { ok: false, code: "invalid_verdict" },
    ]);
  });
});
