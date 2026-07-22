import { describe, expect, test } from "bun:test";
import { parseReviewPromptResponse } from "../src/review-response";
import {
  allowVerdict,
  INVALID_CATEGORY_CASES,
  responseExpectation,
  supportedResponsePartCases,
  VALID_CATEGORY_CASES,
  validPromptResponse,
  validPromptResponseWithParts,
} from "./fixtures/opencode-review-fixtures";

const withInfo = (override: Readonly<Record<string, unknown>>) => {
  const response = validPromptResponse();
  return { ...response, info: { ...response.info, ...override } };
};

describe("review prompt source schema", () => {
  test.each([
    ["message id", { id: "" }],
    ["session", { sessionID: "other" }],
    ["parent", { parentID: "assistant-message" }],
    ["agent", { agent: "other" }],
    ["mode", { mode: "other" }],
    ["cwd", { path: { cwd: "/other", root: "/workspace" } }],
    ["root", { path: { cwd: "/workspace", root: "/other" } }],
    ["provider", { providerID: "" }],
    ["model", { modelID: "other" }],
    ["created", { time: { created: Number.NaN, completed: 21 } }],
    ["completed", { time: { created: 22, completed: 21 } }],
    ["cost", { cost: -1 }],
    ["tokens", { tokens: { input: -1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } }],
    ["finish", { finish: "tool-calls" }],
    ["error", { error: { name: "UnknownError", data: { message: "private" } } }],
    ["unknown", { unexpected: true }],
  ] as const)("rejects invalid assistant %s", (_label, override) => {
    // Given one source assistant identity or completion invariant is invalid.
    // When the strict response parser evaluates it.
    const result = parseReviewPromptResponse(withInfo(override), responseExpectation());

    // Then the response fails closed at its schema or identity boundary.
    expect(result.ok).toBe(false);
  });

  test.each(supportedResponsePartCases())("accepts %s without treating its content as verdict text", (_label, part) => {
    // Given one exact completed source-runtime part containing a conflicting verdict outside ordinary text.
    const response = validPromptResponseWithParts([part]);

    // When the strict response parser evaluates the supported branch.
    const result = parseReviewPromptResponse(response, responseExpectation());

    // Then only the ordinary text verdict is extracted and returned.
    expect(result).toEqual({ ok: true, value: {
      outcome: "allow",
      riskLevel: "low",
      userAuthorization: "unknown",
      categories: [{ id: "security.reviewed", score: 0.1 }],
      reasons: ["bounded command"],
    } });
  });

  test.each([
    ["running guarded tool", {
      type: "tool", callID: "call", tool: "opencode_smart_approval_read",
      state: { status: "running", input: {}, title: "Read", metadata: {}, time: { start: 1 } },
    }],
    ["guarded tool attachment", {
      type: "tool", callID: "call", tool: "opencode_smart_approval_read",
      state: {
        status: "completed", input: {}, output: "ignored", title: "Read", metadata: {},
        time: { start: 1, end: 2 },
        attachments: [{
          id: "part-attachment", sessionID: "child-session", messageID: "assistant-message",
          type: "file", mime: "text/plain", url: "file:///tmp/private",
        }],
      },
    }],
    ["unknown reasoning field", {
      type: "reasoning", text: "ignored", time: { start: 1, end: 2 }, unexpected: true,
    }],
    ["cross-message reasoning", {
      type: "reasoning", text: "ignored", time: { start: 1, end: 2 }, messageID: "other-message",
    }],
  ] as const)("rejects a %s source branch", (_label, partBody) => {
    // Given one forbidden or identity-mismatched source-runtime branch.
    const part = {
      id: "part-forbidden", sessionID: "child-session", messageID: "assistant-message", ...partBody,
    };

    // When the strict response parser checks the complete response.
    const result = parseReviewPromptResponse(validPromptResponseWithParts([part]), responseExpectation());

    // Then it fails closed instead of extracting external branch content.
    expect(result.ok).toBe(false);
  });

  test.each([
    ["unknown", { type: "file", mime: "text/plain", url: "file:///tmp/a" }],
    ["pending tool", { type: "tool", callID: "call", tool: "opencode_smart_approval_read", state: { status: "pending", input: {}, raw: "{}" } }],
    ["other tool", { type: "tool", callID: "call", tool: "bash", state: { status: "error", input: {}, error: "no", time: { start: 1, end: 2 } } }],
    ["unfinished reasoning", { type: "reasoning", text: "think", time: { start: 1 } }],
  ] as const)("rejects a %s part", (_label, partBody) => {
    // Given a part outside the allowed completed review grammar.
    const response = validPromptResponse();
    const part = { id: "part-bad", sessionID: "child-session", messageID: "assistant-message", ...partBody };

    // When the strict part union evaluates it.
    const result = parseReviewPromptResponse({ ...response, parts: [...response.parts, part] }, responseExpectation());

    // Then pending, other-tool, unfinished, and unknown parts are denied.
    expect(result.ok).toBe(false);
  });

  test("rejects cross-session and duplicate part identities", () => {
    // Given parts attached to the wrong session and a duplicated part ID.
    const response = validPromptResponse();
    const first = response.parts[0];
    if (!first) throw new Error("missing fixture part");
    const crossSession = { ...first, sessionID: "other" };

    // When identity validation checks both variants.
    const results = [
      { ...response, parts: [...response.parts, crossSession] },
      { ...response, parts: [...response.parts, first] },
    ].map((value) => parseReviewPromptResponse(value, responseExpectation()));

    // Then neither attachment ambiguity is accepted.
    expect(results.every((result) => !result.ok)).toBe(true);
  });

  test.each([
    ["fence", `\`\`\`json\n${JSON.stringify(allowVerdict())}\n\`\`\``],
    ["prose", `result: ${JSON.stringify(allowVerdict())}`],
    ["multiple", `${JSON.stringify(allowVerdict())}${JSON.stringify(allowVerdict())}`],
    ["unknown field", JSON.stringify({ ...allowVerdict(), extra: true })],
    ["empty categories", JSON.stringify({ ...allowVerdict(), categories: [] })],
    ["empty reasons", JSON.stringify({ ...allowVerdict(), reasons: [] })],
    ["bad score", JSON.stringify({ ...allowVerdict(), categories: [{ id: "security.bad", score: 2 }] })],
    ["no text", ""],
  ] as const)("rejects %s verdict text", (_label, text) => {
    // Given one response with invalid complete JSON verdict text.
    const response = validPromptResponse();
    const parts = response.parts.map((part) => part.type === "text" ? { ...part, text } : part);

    // When the one-shot verdict parser runs without repair or retry.
    const result = parseReviewPromptResponse({ ...response, parts }, responseExpectation());

    // Then the provider text cannot be salvaged into authorization.
    expect(result).toEqual({ ok: false, code: "invalid_verdict" });
  });

  test.each(INVALID_CATEGORY_CASES)("rejects %s category IDs", (_label, categories) => {
    // Given an otherwise valid allow verdict with invalid or ambiguous category identifiers.
    const response = validPromptResponse({ ...allowVerdict(), categories });

    // When the strict one-shot verdict parser checks the fixed category contract.
    const result = parseReviewPromptResponse(response, responseExpectation());

    // Then no invalid category can authorize an allow response.
    expect(result).toEqual({ ok: false, code: "invalid_verdict" });
  });

  test.each(VALID_CATEGORY_CASES)("accepts %s category IDs", (_label, categories) => {
    // Given a valid allow verdict at a supported category grammar boundary.
    const response = validPromptResponse({ ...allowVerdict(), categories });

    // When the strict one-shot verdict parser checks the fixed category contract.
    const result = parseReviewPromptResponse(response, responseExpectation());

    // Then the valid categories survive unchanged.
    expect(result).toEqual({ ok: true, value: {
      outcome: "allow",
      riskLevel: "low",
      userAuthorization: "unknown",
      categories,
      reasons: ["bounded command"],
    } });
  });
});
