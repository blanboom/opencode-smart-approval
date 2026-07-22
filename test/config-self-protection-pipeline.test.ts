import { describe, expect, test } from "bun:test";
import { pipelineFixture, runCommand } from "./fixtures/decision-pipeline-fixture";

describe("config self-protection decision ordering", () => {
  test("preserves a user deny when self-protection forces review", async () => {
    // Given an interpreter mutation is both user-denied and ambiguous to self-protection.
    const fixture = pipelineFixture({
      deny: [{ match: "^python(?:\\s|$).*", scope: "segment", priority: 100 }],
    });
    try {
      // When the command is evaluated through the real hook.
      const action = runCommand(fixture, "python -c scanner-block");

      // Then user deny remains terminal before Tirith or reviewer work.
      await expect(action).rejects.toMatchObject({
        name: "CommandApprovalError",
        verdict: { source: "rule" },
      });
      expect(fixture.scans()).toEqual([]);
      expect(fixture.reviewCount()).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  test("lets Tirith block after self-protection skips a trusted allow", async () => {
    // Given an allow-all rule and an ambiguous interpreter mutation Tirith rejects.
    const fixture = pipelineFixture({
      allow: [{ match: "^python(?:\\s|$).*", scope: "segment", priority: 100 }],
    });
    try {
      // When self-protection forces the complete post-deny pipeline.
      const action = runCommand(fixture, "python -c scanner-block");

      // Then the allow shortcut is skipped, Tirith blocks, and reviewer is not called.
      await expect(action).rejects.toMatchObject({
        name: "CommandApprovalError",
        verdict: { source: "risk_tool" },
      });
      expect(fixture.scans()).toEqual(["python -c scanner-block"]);
      expect(fixture.reviewCount()).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });
});
