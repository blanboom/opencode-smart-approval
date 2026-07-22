import { describe, expect, test } from "bun:test";
import { buildCommandContext } from "../src/context";
import { defaultPolicy } from "../src/default-config";
import { evaluateRules } from "../src/rules";
import { enforceVerdict, verdictFromReview } from "../src/verdict";

describe("rule evaluation", () => {
  test("allow rules short-circuit constrained non-output commands", async () => {
    // Given the resolved policy and a static shell predicate.

    // When deterministic rules evaluate the command.
    const evaluation = await evaluateRules(defaultPolicy().rules, { command: "test -n hello" });

    // Then the predicate takes the narrow builtin fast path.
    expect(evaluation.decision).toBe("allow");
    expect(evaluation.matchedRules.map((rule) => rule.label)).toContain("builtin.allow[0]");
  });

  test("normal git push goes to review", async () => {
    const evaluation = await evaluateRules(defaultPolicy().rules, { command: "git push origin main" });
    expect(evaluation.decision).toBe("review");
  });

  test("leaves git no-verify unmatched for the scanner", async () => {
    const evaluation = await evaluateRules(defaultPolicy().rules, { command: "git commit --no-verify -m test" });
    expect(evaluation.decision).toBe("review");
    expect(evaluation.matchedRules).toEqual([]);
  });
});

describe("command context", () => {
  test("preserves dynamic and commented shell commands without eager script inspection", () => {
    // Given commands whose script targets cannot be safely resolved before review.
    const commands = ["sh ./missing.sh # review at execution time", 'sh "$SCRIPT"'];

    // When command context is built for the approval pipeline.
    const contexts = commands.map((command) => buildCommandContext(
      { tool: "bash", sessionID: "session-1" },
      { command },
      "/canonical/project",
    ));

    // Then only the original command metadata is retained and no script is read eagerly.
    expect(contexts).toEqual(commands.map((command) => ({
      sessionID: "session-1",
      tool: "bash",
      command,
      cwd: "/canonical/project",
      args: { command },
    })));
    expect(contexts.every((context) => context && !("scriptEvidence" in context))).toBe(true);
  });
});

describe("reviewer response parsing", () => {
  test("flows reviewer deny reasons into OpenCode error", () => {
    const verdict = verdictFromReview(
      {
        outcome: "deny",
        riskLevel: "high",
        userAuthorization: "unknown",
        categories: [{ id: "network.exfiltration", score: 0.9 }],
        reasons: ["would upload a private key"],
      },
      { decision: "review", matchedRules: [], categories: [], reasons: [] },
    );
    expect(() => enforceVerdict("bash", verdict)).toThrow(
      "reason=reviewer: would upload a private key",
    );
  });
});
