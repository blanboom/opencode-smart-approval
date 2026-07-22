import { describe, expect, test } from "bun:test";
import { buildReviewPrompt } from "../src/prompt";
import type { CommandContext, RuleEvaluation } from "../src/types";

const context: CommandContext = {
  sessionID: "parent-session",
  tool: "bash",
  command: "sh ./downloaded.sh",
  cwd: "/workspace",
  args: { command: "sh ./downloaded.sh" },
};

const evaluation: RuleEvaluation = {
  decision: "review",
  matchedRules: [],
  categories: [],
  reasons: [],
};

const requestJson = (prompt: string): unknown => {
  const marker = "Approval request JSON:\n";
  const markerPosition = prompt.lastIndexOf(marker);
  if (markerPosition < 0) throw new Error("approval request marker missing");
  return JSON.parse(prompt.slice(markerPosition + marker.length));
};

describe("review prompt transcript boundary", () => {
  test("redacts exact authorization phrases before every review request", () => {
    // Given a directly constructed reviewer transcript containing an exact authorization phrase.
    const phrase = `AUTHORIZE opencode-smart-approval ${"A".repeat(43)}`;
    const transcript = {
      status: "available" as const,
      messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: `before ${phrase} after` }] }],
    };

    // When the reviewer request prompt is built.
    const prompt = buildReviewPrompt(context, evaluation, transcript, "Apply policy.");

    // Then the serialized request has a redacted reviewer projection and no legacy or auth channel.
    expect(prompt).not.toContain(phrase);
    expect(requestJson(prompt)).toEqual({
      tool: "bash",
      command: "sh ./downloaded.sh",
      cwd: "/workspace",
      args: { command: "sh ./downloaded.sh" },
      matched_rules: [],
      risk_categories: [],
      approval_notes: [],
      transcript: {
        status: "available",
        messages: [{ role: "user", parts: [{ type: "text", text: "before [authorization phrase redacted] after" }] }],
      },
    });
    expect(prompt).not.toContain("script_evidence");
    expect(prompt).not.toContain("authorizationMessages");
  });

  test("serializes transcript status without fabricated content", () => {
    // Given a fixed status-only transcript failure.
    const transcript = { status: "unavailable" as const, reason: "timeout" as const };

    // When the reviewer request prompt is built.
    const prompt = buildReviewPrompt(context, evaluation, transcript, "Apply policy.");

    // Then the status reaches the request without messages or authorization data.
    expect(requestJson(prompt)).toEqual({
      tool: "bash",
      command: "sh ./downloaded.sh",
      cwd: "/workspace",
      args: { command: "sh ./downloaded.sh" },
      matched_rules: [],
      risk_categories: [],
      approval_notes: [],
      transcript: { status: "unavailable", reason: "timeout" },
    });
  });
});
