import { describe, expect, test } from "bun:test";
import { createMonotonicDeadline } from "../src/bounded-race";
import { createReviewHandle } from "../src/review-handle";
import { reviewWithOpenCode } from "../src/opencode-reviewer";
import type { SerializeReviewRequestInput } from "../src/review-request";
import {
  allowVerdict,
  expectedAgentFixture,
  INVALID_CATEGORY_CASES,
  validCreatedSession,
  validPromptResponse,
} from "./fixtures/opencode-review-fixtures";
import { reviewRuntimeFixture } from "./fixtures/opencode-review-runtime";

const request: SerializeReviewRequestInput = {
  context: { sessionID: "parent-session", tool: "bash", command: "echo ok", cwd: "/workspace", args: {} },
  shellAnalysis: { source: "echo ok", segments: [], redirections: [], staticFileReferences: [], issues: [], nestedAnalyses: [] },
  evaluation: { decision: "review", matchedRules: [], categories: [], reasons: [] },
  tirith: { action: "allow" },
  transcript: { status: "disabled" },
};

const isFailClosed = (value: { readonly outcome: string; readonly categories: readonly { readonly id: string }[] }) =>
  value.outcome === "deny" && value.categories.some((category) => category.id === "security.reviewer_unavailable");

describe("direct OpenCode reviewer failures", () => {
  test("starts no OpenCode call for invalid prototype-bearing context args", async () => {
    // Given context args whose array identity has a replaced prototype.
    const args = ["unsafe"];
    Object.setPrototypeOf(args, {});
    const agent = expectedAgentFixture();
    const fixture = reviewRuntimeFixture(async (method) => {
      if (method === "agents") return { ok: true, data: [agent.runtime] };
      if (method === "create") return { ok: true, data: validCreatedSession() };
      if (method === "prompt") return { ok: true, data: validPromptResponse() };
      if (method === "delete") return { ok: true, data: true };
      return { ok: false, code: "sdk_error" };
    });

    // When review receives the invalid public request state.
    const response = await reviewWithOpenCode(fixture.runtime, {
      parentSessionID: "parent-session",
      deadline: createMonotonicDeadline(5_000),
      request: { ...request, context: { ...request.context, args } },
    });

    // Then serialization fails closed before agents, create, prompt, activation, or cleanup.
    expect(isFailClosed(response)).toBe(true);
    expect(fixture.calls).toEqual([]);
    expect(fixture.activations).toEqual([]);
    expect(fixture.revocations).toEqual([]);
  });

  test("rejects a duplicate created ID without reusing existing ownership", async () => {
    // Given an existing owned handle and a create response that repeats its child ID.
    const agent = expectedAgentFixture();
    const fixture = reviewRuntimeFixture(async (method) => {
      if (method === "agents") return { ok: true, data: [agent.runtime] };
      if (method === "create") return { ok: true, data: validCreatedSession() };
      return { ok: false, code: "sdk_error" };
    });
    const existing = createReviewHandle({
      childID: "child-session",
      directory: "/workspace",
      cleanupEnabled: true,
      revoke: () => true,
      abort: async () => ({ ok: true, data: true }),
      delete: async () => ({ ok: true, data: true }),
    });
    fixture.runtime.registry.add(existing);

    // When a new review attempts to claim that duplicate response.
    const response = await reviewWithOpenCode(fixture.runtime, {
      parentSessionID: "parent-session", deadline: createMonotonicDeadline(5_000), request,
    });

    // Then it fails closed before activation and leaves the original ownership unchanged.
    expect(isFailClosed(response)).toBe(true);
    expect(fixture.calls.map((call) => call.method)).toEqual(["agents", "create"]);
    expect(fixture.activations).toEqual([]);
    expect(existing.snapshot().state).toBe("owned_inactive");
  });

  test("does not clean a malformed nonempty child with mismatched project identity", async () => {
    // Given a create response with a nonempty ID but mismatched project identity.
    const agent = expectedAgentFixture();
    const fixture = reviewRuntimeFixture(async (method) => {
      if (method === "agents") return { ok: true, data: [agent.runtime] };
      if (method === "create") return { ok: true, data: { ...validCreatedSession(), projectID: "other" } };
      if (method === "delete") return { ok: true, data: true };
      return { ok: false, code: "sdk_error" };
    });

    // When review validates the create response.
    const response = await reviewWithOpenCode(fixture.runtime, {
      parentSessionID: "parent-session", deadline: createMonotonicDeadline(5_000), request,
    });

    // Then it fails closed without establishing deletion ownership.
    expect(isFailClosed(response)).toBe(true);
    expect(fixture.calls.map((call) => call.method)).toEqual(["agents", "create"]);
    expect(fixture.activations).toEqual([]);
  });

  test("detects agent mutation before prompt and revokes before cleanup", async () => {
    // Given the second app.agents response mutates the fixed prompt.
    const agent = expectedAgentFixture();
    let agentCalls = 0;
    const fixture = reviewRuntimeFixture(async (method) => {
      if (method === "agents") {
        agentCalls += 1;
        return { ok: true, data: [agentCalls === 1 ? agent.runtime : { ...agent.runtime, prompt: "changed" }] };
      }
      if (method === "create") return { ok: true, data: validCreatedSession() };
      if (method === "delete") return { ok: true, data: true };
      return { ok: false, code: "sdk_error" };
    });

    // When the pre-prompt runtime check runs.
    const response = await reviewWithOpenCode(fixture.runtime, {
      parentSessionID: "parent-session", deadline: createMonotonicDeadline(5_000), request,
    });

    // Then no prompt occurs and ownership is revoked before deletion.
    expect(isFailClosed(response)).toBe(true);
    expect(fixture.calls.map((call) => call.method)).toEqual(["agents", "create", "agents", "delete"]);
    expect(fixture.revocations).toEqual([{ sessionID: "child-session", generation: 1 }]);
  });

  test.each(INVALID_CATEGORY_CASES)("fails closed for %s category IDs and cleans once", async (_label, categories) => {
    // Given a fixed approval agent returns an allow verdict with invalid or duplicate category identifiers.
    const agent = expectedAgentFixture();
    const fixture = reviewRuntimeFixture(async (method) => {
      if (method === "agents") return { ok: true, data: [agent.runtime] };
      if (method === "create") return { ok: true, data: validCreatedSession() };
      if (method === "prompt") return { ok: true, data: validPromptResponse({ ...allowVerdict(), categories }) };
      if (method === "delete") return { ok: true, data: true };
      return { ok: false, code: "sdk_error" };
    });

    // When the complete reviewer lifecycle validates the returned verdict.
    const response = await reviewWithOpenCode(fixture.runtime, {
      parentSessionID: "parent-session", deadline: createMonotonicDeadline(5_000), request,
    });

    // Then it denies as unavailable, revokes ownership, and deletes the exact child once.
    expect(response).toEqual({
      outcome: "deny",
      riskLevel: "high",
      userAuthorization: "unknown",
      categories: [{ id: "security.reviewer_unavailable", score: 1 }],
      reasons: ["reviewer_failure:invalid_verdict"],
    });
    expect(fixture.calls.map((call) => call.method)).toEqual(["agents", "create", "agents", "prompt", "delete"]);
    expect(fixture.activations).toHaveLength(1);
    expect(fixture.revocations).toHaveLength(1);
    expect(fixture.runtime.registry.get("child-session")).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain(categories[0]?.id ?? "raw-invalid-category");
  });
});
