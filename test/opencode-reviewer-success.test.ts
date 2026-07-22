import { describe, expect, test } from "bun:test";
import { createMonotonicDeadline } from "../src/bounded-race";
import { reviewWithOpenCode } from "../src/opencode-reviewer";
import type { SerializeReviewRequestInput } from "../src/review-request";
import {
  expectedAgentFixture,
  supportedResponsePartCases,
  validCreatedSession,
  validPromptResponse,
  validPromptResponseWithParts,
} from "./fixtures/opencode-review-fixtures";
import { validSourceCreatedSession } from "./fixtures/opencode-session-fixtures";
import { reviewRuntimeFixture } from "./fixtures/opencode-review-runtime";

const request: SerializeReviewRequestInput = {
  context: { sessionID: "parent-session", tool: "bash", command: "echo ok", cwd: "/workspace", args: { command: "echo ok" } },
  shellAnalysis: { source: "echo ok", segments: [], redirections: [], staticFileReferences: [], issues: [], nestedAnalyses: [] },
  evaluation: { decision: "review", matchedRules: [], categories: [], reasons: [] },
  tirith: { action: "allow" },
  transcript: { status: "available", messages: [] },
};

describe("direct OpenCode reviewer success", () => {
  test("validates agents twice, activates one lease, prompts once, and deletes", async () => {
    // Given exact root data for one successful owned review.
    const agent = expectedAgentFixture();
    const fixture = reviewRuntimeFixture(async (method) => {
      if (method === "agents") return { ok: true, data: [agent.runtime] };
      if (method === "create") return { ok: true, data: validCreatedSession() };
      if (method === "prompt") return { ok: true, data: validPromptResponse() };
      if (method === "delete") return { ok: true, data: true };
      return { ok: false, code: "sdk_error" };
    });

    // When the direct reviewer runs under one overall deadline.
    const response = await reviewWithOpenCode(fixture.runtime, {
      parentSessionID: "parent-session", deadline: createMonotonicDeadline(5_000), request,
    });

    // Then the exact lifecycle returns the strict allow verdict and revokes ownership.
    expect(response).toEqual({
      outcome: "allow", riskLevel: "low", userAuthorization: "unknown",
      categories: [{ id: "security.reviewed", score: 0.1 }], reasons: ["bounded command"],
    });
    expect(fixture.calls.map((call) => call.method)).toEqual(["agents", "create", "agents", "prompt", "delete"]);
    expect(fixture.activations).toEqual([{
      sessionID: "child-session", agent: "opencode-smart-approval-reviewer",
      directory: "/workspace", references: [],
    }]);
    expect(fixture.revocations).toEqual([{ sessionID: "child-session", generation: 1 }]);
    const prompt = fixture.calls.find((call) => call.method === "prompt")?.input;
    expect(prompt).toEqual({
      sessionID: "child-session",
      directory: "/workspace",
      agent: "opencode-smart-approval-reviewer",
      tools: { "*": false, opencode_smart_approval_read: true },
      text: expect.stringContaining('"schema_version":1'),
      signal: expect.any(AbortSignal),
    });
  });

  test("accepts every completed response branch while extracting only ordinary text", async () => {
    // Given one legitimate response containing completed reasoning and both guarded-reader terminal states.
    const agent = expectedAgentFixture();
    const supportedParts = supportedResponsePartCases().map((entry) => entry[1]);
    const fixture = reviewRuntimeFixture(async (method) => {
      if (method === "agents") return { ok: true, data: [agent.runtime] };
      if (method === "create") return { ok: true, data: validCreatedSession() };
      if (method === "prompt") return { ok: true, data: validPromptResponseWithParts(supportedParts) };
      if (method === "delete") return { ok: true, data: true };
      return { ok: false, code: "sdk_error" };
    });

    // When the complete direct reviewer lifecycle parses that response.
    const response = await reviewWithOpenCode(fixture.runtime, {
      parentSessionID: "parent-session", deadline: createMonotonicDeadline(5_000), request,
    });

    // Then the ordinary text verdict wins and the one owned lease is cleaned exactly once.
    expect(response).toEqual({
      outcome: "allow", riskLevel: "low", userAuthorization: "unknown",
      categories: [{ id: "security.reviewed", score: 0.1 }], reasons: ["bounded command"],
    });
    expect(fixture.calls.map((call) => call.method)).toEqual(["agents", "create", "agents", "prompt", "delete"]);
    expect(fixture.activations).toHaveLength(1);
    expect(fixture.revocations).toHaveLength(1);
    const prompt = fixture.calls.find((call) => call.method === "prompt")?.input;
    expect(prompt).toMatchObject({ tools: { "*": false, opencode_smart_approval_read: true } });
  });

  test("accepts the complete pinned-source Session.Info lifecycle", async () => {
    // Given create returns every legitimate optional and nested Session.Info field.
    const agent = expectedAgentFixture();
    const fixture = reviewRuntimeFixture(async (method) => {
      if (method === "agents") return { ok: true, data: [agent.runtime] };
      if (method === "create") return { ok: true, data: validSourceCreatedSession() };
      if (method === "prompt") return { ok: true, data: validPromptResponse() };
      if (method === "delete") return { ok: true, data: true };
      return { ok: false, code: "sdk_error" };
    });

    // When the direct reviewer validates and owns the source-valid child.
    const response = await reviewWithOpenCode(fixture.runtime, {
      parentSessionID: "parent-session", deadline: createMonotonicDeadline(5_000), request,
    });

    // Then it performs the exact lifecycle and returns the review verdict.
    expect(response.outcome).toBe("allow");
    expect(fixture.calls.map((call) => call.method)).toEqual(["agents", "create", "agents", "prompt", "delete"]);
    expect(fixture.activations).toHaveLength(1);
    expect(fixture.revocations).toHaveLength(1);
  });
});
