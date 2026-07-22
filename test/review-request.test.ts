import { describe, expect, test } from "bun:test";
import { MAX_REVIEW_REQUEST_UTF8_BYTES, serializeReviewRequest } from "../src/review-request";
import type { SerializeReviewRequestInput } from "../src/review-request";
import { registerConfirmationRedactionTests } from "./fixtures/confirmation-redaction-suite";

const requestInput = (args: unknown = { command: "echo ok", z: 1, a: 2 }): SerializeReviewRequestInput => ({
  context: { sessionID: "parent", tool: "bash", command: "echo ok", cwd: "/workspace", args },
  shellAnalysis: {
    source: "echo ok",
    segments: [],
    redirections: [],
    staticFileReferences: [],
    issues: [{ kind: "dynamic", reason: "review this" }],
    nestedAnalyses: [],
  },
  evaluation: {
    decision: "review",
    matchedRules: [{
      index: 2, label: "review-shell", match: "^echo", decision: "review", scope: "command",
      priority: 5, origin: "user", regex: /^echo/u, reason: "rule evidence",
    }],
    categories: [{ id: "security.shell", score: 0.4 }],
    reasons: ["review required"],
  },
  tirith: {
    action: "warn",
    riskLevel: "medium",
    categories: [{ id: "risk_tool.shell", score: 0.5 }],
    reasons: ["scanner warning"],
    freshness: "current",
  },
  transcript: {
    status: "available",
    messages: [{ role: "user", parts: [{ type: "text", text: "please inspect" }] }],
  },
});

registerConfirmationRedactionTests(requestInput);

describe("stable approval ReviewRequest", () => {
  test("serializes only hash-bound plugin confirmation proof", () => {
    // Given a confirmed retry with hash-only plugin proof.
    const proof = {
      status: "confirmed" as const,
      effect_sha256: "a".repeat(64),
      disclosure_sha256: "b".repeat(64),
    };

    // When the second reviewer request is serialized.
    const result = serializeReviewRequest({ ...requestInput(), authorizationProof: proof });

    // Then the child receives only the fixed proof object and no token-shaped value.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.json);
    expect(parsed.authorization_proof).toEqual(proof);
    expect(result.json).not.toContain("AUTHORIZE opencode-smart-approval");
    expect(result.json).not.toContain("C".repeat(43));
  });
  test("projects only the strict version-one DTO with sorted keys", () => {
    // Given command state containing an internal RegExp and session identity.
    const input = requestInput();

    // When the stable reviewer payload is serialized twice.
    const first = serializeReviewRequest(input);
    const second = serializeReviewRequest(input);

    // Then the payload is deterministic and excludes internal and identity-only fields.
    expect(first.ok).toBe(true);
    expect(first).toEqual(second);
    if (!first.ok) throw new Error("expected serialized request");
    expect(first.json.startsWith('{"args":{"a":2,"command":"echo ok","z":1},"command"')).toBe(true);
    const parsed: unknown = JSON.parse(first.json);
    expect(parsed).toEqual({
      args: { a: 2, command: "echo ok", z: 1 },
      command: "echo ok",
      cwd: "/workspace",
      rule_evaluation: {
        categories: [{ id: "security.shell", score: 0.4 }],
        matched_labels: ["review-shell"],
        reasons: ["review required"],
      },
      schema_version: 1,
      shell_analysis: {
        issues: [{ kind: "dynamic", reason: "review this" }],
        nested_analyses: [], redirections: [], segments: [], source: "echo ok", static_file_references: [],
      },
      tirith: {
        action: "warn", categories: [{ id: "risk_tool.shell", score: 0.5 }], freshness: "current",
        reasons: ["scanner warning"], risk_level: "medium",
      },
      transcript: input.transcript,
    });
    expect(first.json).not.toContain("sessionID");
    expect(first.json).not.toContain("regex");
    expect(first.json).not.toContain("rule evidence");
  });

  test.each([
    ["cycle", () => { const value: Record<string, unknown> = {}; value["self"] = value; return value; }],
    ["nonfinite", () => ({ value: Number.POSITIVE_INFINITY })],
    ["bigint", () => ({ value: BigInt(1) })],
    ["function", () => ({ value: () => true })],
    ["symbol", () => ({ value: Symbol("value") })],
    ["prototype", () => ({ value: new Date(0) })],
    ["undefined", () => ({ value: undefined })],
  ] as const)("rejects unsupported %s request data", (_label, createArgs) => {
    // Given args containing a JSON-unsafe value.
    // When the DTO crosses the stable serializer.
    const result = serializeReviewRequest(requestInput(createArgs()));

    // Then child creation can fail closed before receiving a payload.
    expect(result).toEqual({ ok: false, code: "invalid_json" });
  });

  test("enforces the fixed UTF-8 payload ceiling", () => {
    // Given args whose string makes the complete payload exceed 131072 UTF-8 bytes.
    const input = requestInput({ value: "界".repeat(MAX_REVIEW_REQUEST_UTF8_BYTES) });

    // When the request is serialized.
    const result = serializeReviewRequest(input);

    // Then the bounded request fails before any OpenCode child call.
    expect(result).toEqual({ ok: false, code: "limit_exceeded" });
  });
});
