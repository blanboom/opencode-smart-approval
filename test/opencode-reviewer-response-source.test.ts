import { describe, expect, test } from "bun:test";
import { APPROVAL_AGENT_NAME } from "../src/approval-agent";
import { createMonotonicDeadline } from "../src/bounded-race";
import { reviewWithOpenCode } from "../src/opencode-reviewer";
import type { SerializeReviewRequestInput } from "../src/review-request";
import { invalidSourceResponseCases } from "./fixtures/opencode-response-source";
import {
  expectedAgentFixture,
  sourceCompletePromptResponse,
  validCreatedSession,
} from "./fixtures/opencode-review-fixtures";
import { reviewRuntimeFixture } from "./fixtures/opencode-review-runtime";

const request: SerializeReviewRequestInput = {
  context: { sessionID: "parent-session", tool: "bash", command: "echo ok", cwd: "/workspace", args: {} },
  shellAnalysis: {
    source: "echo ok", segments: [], redirections: [], staticFileReferences: [], issues: [], nestedAnalyses: [],
  },
  evaluation: { decision: "review", matchedRules: [], categories: [], reasons: [] },
  tirith: { action: "allow" },
  transcript: { status: "disabled" },
};

describe("pinned source response reviewer lifecycle", () => {
  test("allows the combined source-valid response and deletes the exact child", async () => {
    // Given a complete source response whose non-text fields contain conflicting verdict-like data.
    const agent = expectedAgentFixture();
    const fixture = reviewRuntimeFixture(async (method) => {
      if (method === "agents") return { ok: true, data: [agent.runtime] };
      if (method === "create") return { ok: true, data: validCreatedSession() };
      if (method === "prompt") return { ok: true, data: sourceCompletePromptResponse() };
      if (method === "delete") return { ok: true, data: true };
      return { ok: false, code: "sdk_error" };
    });

    // When the exported reviewer validates, owns, prompts, and cleans the child.
    const response = await reviewWithOpenCode(fixture.runtime, {
      parentSessionID: "parent-session", deadline: createMonotonicDeadline(5_000), request,
    });

    // Then ordinary text alone allows after one exact lifecycle and terminal deletion.
    expect(response).toEqual({
      outcome: "allow", riskLevel: "low", userAuthorization: "unknown",
      categories: [{ id: "security.reviewed", score: 0.1 }], reasons: ["bounded command"],
    });
    expect(fixture.calls.map((call) => call.method)).toEqual(["agents", "create", "agents", "prompt", "delete"]);
    expect(fixture.activations).toEqual([{
      sessionID: "child-session", agent: APPROVAL_AGENT_NAME, directory: "/workspace", references: [],
    }]);
    expect(fixture.revocations).toEqual([{ sessionID: "child-session", generation: 1 }]);
    expect(fixture.calls.find((call) => call.method === "delete")?.input).toEqual({
      sessionID: "child-session", directory: "/workspace", signal: expect.any(AbortSignal),
    });
    expect(fixture.runtime.registry.get("child-session")).toBeUndefined();
  });

  test.each(invalidSourceResponseCases())("fails closed and deletes once for malformed source %s", async (
    _label,
    sourceResponse,
  ) => {
    // Given one invalid source response after a valid owned child and active lease.
    const agent = expectedAgentFixture();
    const fixture = reviewRuntimeFixture(async (method) => {
      if (method === "agents") return { ok: true, data: [agent.runtime] };
      if (method === "create") return { ok: true, data: validCreatedSession() };
      if (method === "prompt") return { ok: true, data: sourceResponse() };
      if (method === "delete") return { ok: true, data: true };
      return { ok: false, code: "sdk_error" };
    });

    // When the exported reviewer rejects the malformed prompt response.
    const response = await reviewWithOpenCode(fixture.runtime, {
      parentSessionID: "parent-session", deadline: createMonotonicDeadline(5_000), request,
    });

    // Then it fails closed, revokes once, and performs one exact child delete without leaking content.
    expect(response).toEqual({
      outcome: "deny", riskLevel: "high", userAuthorization: "unknown",
      categories: [{ id: "security.reviewer_unavailable", score: 1 }],
      reasons: ["reviewer_failure:malformed_envelope"],
    });
    expect(fixture.calls.map((call) => call.method)).toEqual(["agents", "create", "agents", "prompt", "delete"]);
    expect(fixture.activations).toHaveLength(1);
    expect(fixture.revocations).toHaveLength(1);
    expect(fixture.calls.find((call) => call.method === "delete")?.input).toEqual({
      sessionID: "child-session", directory: "/workspace", signal: expect.any(AbortSignal),
    });
    expect(fixture.runtime.registry.get("child-session")).toBeUndefined();
    expect(JSON.stringify(response)).not.toMatch(/private|unexpected|Infinity|NaN/u);
  });
});
