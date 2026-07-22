import { describe, expect, test } from "bun:test";
import { createMonotonicDeadline } from "../src/bounded-race";
import { reviewWithOpenCode } from "../src/opencode-reviewer";
import type { SerializeReviewRequestInput } from "../src/review-request";
import { expectedAgentFixture } from "./fixtures/opencode-review-fixtures";
import {
  MALFORMED_SOURCE_SESSION_CASES,
  nonCleanableSourceSessionCases,
  validSourceCreatedSession,
} from "./fixtures/opencode-session-fixtures";
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

const CREATED_IDENTITY_FIELDS = new Set([
  "project type", "missing project", "project mismatch",
  "directory type", "missing directory", "directory mismatch",
  "parent type", "missing parent", "parent mismatch",
  "missing title", "title type", "title mismatch",
]);

const cleanupOwnedCases = MALFORMED_SOURCE_SESSION_CASES.filter(
  ({ label }) => !CREATED_IDENTITY_FIELDS.has(label),
);

const malformedIdentityCases = MALFORMED_SOURCE_SESSION_CASES.filter(
  ({ label }) => CREATED_IDENTITY_FIELDS.has(label),
);

describe("created source Session.Info cleanup", () => {
  test.each(cleanupOwnedCases)("deletes malformed $label exactly once", async ({ mutate }) => {
    // Given create returns one malformed source field while retaining the exact nonempty child ID.
    const agent = expectedAgentFixture();
    const fixture = reviewRuntimeFixture(async (method) => {
      if (method === "agents") return { ok: true, data: [agent.runtime] };
      if (method === "create") return { ok: true, data: mutate(validSourceCreatedSession()) };
      if (method === "delete") return { ok: true, data: true };
      return { ok: false, code: "sdk_error" };
    });

    // When the reviewer validates create ownership.
    const response = await reviewWithOpenCode(fixture.runtime, {
      parentSessionID: "parent-session", deadline: createMonotonicDeadline(5_000), request,
    });

    // Then it fails closed, performs one exact delete, and never prompts or activates a lease.
    expect(response.reasons).toEqual(["reviewer_failure:invalid_session"]);
    expect(fixture.calls.map((call) => call.method)).toEqual(["agents", "create", "delete"]);
    expect(fixture.activations).toEqual([]);
    expect(fixture.revocations).toEqual([]);
    expect(fixture.runtime.registry.get("child-session")).toBeUndefined();
  });

  test.each(malformedIdentityCases)("does not own malformed identity $label", async ({ mutate }) => {
    // Given create returns a nonempty ID without the exact expected creation identity.
    const agent = expectedAgentFixture();
    const fixture = reviewRuntimeFixture(async (method) => {
      if (method === "agents") return { ok: true, data: [agent.runtime] };
      if (method === "create") return { ok: true, data: mutate(validSourceCreatedSession()) };
      if (method === "delete") return { ok: true, data: true };
      return { ok: false, code: "sdk_error" };
    });

    // When the reviewer validates create ownership.
    const response = await reviewWithOpenCode(fixture.runtime, {
      parentSessionID: "parent-session", deadline: createMonotonicDeadline(5_000), request,
    });

    // Then it fails closed without establishing cleanup ownership for that ID.
    expect(response.reasons).toEqual(["reviewer_failure:invalid_session"]);
    expect(fixture.calls.map((call) => call.method)).toEqual(["agents", "create"]);
    expect(fixture.activations).toEqual([]);
    expect(fixture.revocations).toEqual([]);
    expect(fixture.runtime.registry.get("child-session")).toBeUndefined();
  });

  test.each(nonCleanableSourceSessionCases())("does not delete %s", async (_label, created) => {
    // Given create returns malformed data without an exact nonempty string ID.
    const agent = expectedAgentFixture();
    const fixture = reviewRuntimeFixture(async (method) => {
      if (method === "agents") return { ok: true, data: [agent.runtime] };
      if (method === "create") return { ok: true, data: created };
      return { ok: false, code: "sdk_error" };
    });

    // When the reviewer cannot establish exact cleanup ownership.
    const response = await reviewWithOpenCode(fixture.runtime, {
      parentSessionID: "parent-session", deadline: createMonotonicDeadline(5_000), request,
    });

    // Then it fails closed without broad discovery, delete, prompt, or activation.
    expect(response.reasons).toEqual(["reviewer_failure:invalid_session"]);
    expect(fixture.calls.map((call) => call.method)).toEqual(["agents", "create"]);
    expect(fixture.activations).toEqual([]);
    expect(fixture.runtime.registry.get("child-session")).toBeUndefined();
  });
});
