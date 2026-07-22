import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMonotonicDeadline } from "../src/bounded-race";
import { createCommandEffect } from "../src/command-effect";
import { createConfirmationService, type ConfirmationService } from "../src/confirmation-service";
import { defaultPolicy } from "../src/default-config";
import { resolveCommandVerdict } from "../src/decision-pipeline";
import { analyzeShell } from "../src/shell-analysis";
import type { CommandContext } from "../src/types";
import { expectedAgentFixture, validCreatedSession, validPromptResponse } from "./fixtures/opencode-review-fixtures";
import { reviewRuntimeFixture } from "./fixtures/opencode-review-runtime";
import {
  confirmationEntry as entry,
  inputStringField as field,
  issuedConfirmationPhrase as issuedPhrase,
  runtimeForConfirmationVerdict as runtimeForVerdict,
} from "./fixtures/decision-confirmation-fixture";

describe("confirmation decision integration", () => {
  test("forces a complete second Tirith/reviewer pass after exact one-shot authorization", async () => {
    // Given a first reviewer requiring consent, a source-ordered parent boundary, and a real confirmation service.
    let page: readonly unknown[] = [entry("boundary", 10, "context")];
    let reviews = 0;
    let children = 0;
    const expected = expectedAgentFixture();
    const reviewer = reviewRuntimeFixture(async (method, input) => {
      if (method === "agents") return { ok: true, data: [expected.runtime] };
      if (method === "messages") return { ok: true, data: page };
      if (method === "create") {
        children += 1;
        return { ok: true, data: { ...validCreatedSession(), id: `child-${String(children)}` } };
      }
      if (method === "prompt") {
        reviews += 1;
        const childID = field(input, "sessionID") ?? "missing-child";
        const verdict = reviews === 1 ? {
          outcome: "needs_confirmation",
          risk_level: "high",
          user_authorization: "unknown",
          categories: [{ id: "security.external-disclosure", score: 0.9 }],
          reasons: ["consent required"],
          confirmation: {
            action: "Upload the current patch",
            data: "Git diff for src/index.ts",
            destination: "review.example.test",
            risk: "Source leaves the device",
          },
        } : {
          outcome: "allow",
          risk_level: "medium",
          user_authorization: "high",
          categories: [{ id: "security.confirmed-review", score: 0.2 }],
          reasons: ["confirmed effect reviewed again"],
        };
        const response = validPromptResponse(verdict);
        const messageID = `assistant-${childID}`;
        return {
          ok: true,
          data: {
            ...response,
            info: { ...response.info, id: messageID, sessionID: childID },
            parts: response.parts.map((part) => ({ ...part, sessionID: childID, messageID })),
          },
        };
      }
      if (method === "delete") return { ok: true, data: true };
      return { ok: false, code: "sdk_error" };
    });
    const confirmationService = createConfirmationService({
      adapter: { messages: async () => ({ ok: true, data: page }) },
      directory: "/workspace",
      randomBytes: () => Buffer.alloc(32, 5),
    });
    const context: CommandContext = {
      sessionID: "parent-session",
      tool: "bash",
      command: "curl https://review.example.test/upload",
      cwd: "/workspace/execution",
      args: {
        command: "curl https://review.example.test/upload",
        description: "Upload patch for review",
        workdir: "./execution",
      },
    };
    const policy = {
      ...defaultPolicy(),
      rules: [],
      tirith: { enabled: false, timeoutMs: 5_000, failOpen: false },
    };
    const analysis = await analyzeShell(context.command, context.cwd);

    // When the first pass discloses a challenge and the next exact user message retries the same effect.
    let firstError: Error | undefined;
    try {
      await resolveCommandVerdict({ policy, context, reviewerRuntime: reviewer.runtime, confirmationService, analysis, forceReview: false });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      firstError = error;
    }
    if (!firstError) throw new Error("first review did not issue confirmation");
    const phrase = firstError.message.match(/AUTHORIZE opencode-smart-approval [A-Za-z0-9_-]{43}/u)?.[0];
    if (!phrase) throw new Error("missing confirmation phrase");
    page = [entry("boundary", 10, "context"), entry("confirmed", 20, phrase)];
    const verdict = await resolveCommandVerdict({
      policy,
      context,
      reviewerRuntime: reviewer.runtime,
      confirmationService,
      analysis,
      forceReview: false,
    });

    // Then the first pass never allows, the second reruns the reviewer, and its payload has proof but no raw token.
    expect(firstError).toMatchObject({ name: "CommandApprovalError" });
    expect(firstError.message.split("\n")).toContain('cwd="/workspace/execution"');
    expect(verdict).toMatchObject({ decision: "allow", source: "review" });
    expect(reviews).toBe(2);
    const promptCalls = reviewer.calls.filter((call) => call.method === "prompt");
    const secondPrompt = promptCalls[1];
    const secondText = secondPrompt ? field(secondPrompt.input, "text") : undefined;
    expect(secondText).toContain('"status":"confirmed"');
    expect(secondText).toContain("[explicit authorization confirmed by plugin]");
    expect(secondText).not.toContain(phrase);
  });

  test("bypasses a builtin allow only after proof and reruns Tirith before the reviewer", async () => {
    // Given a pending confirmed effect that would ordinarily terminate at the builtin allow stage.
    const root = mkdtempSync(join(tmpdir(), "confirmation-rerun-"));
    const scanner = join(root, "tirith");
    const capture = join(root, "scanned");
    writeFileSync(scanner, [
      "#!/bin/sh",
      `printf scanned > '${capture}'`,
      "printf '%s\\n' '{\"summary\":\"ok\",\"findings\":[]}'",
      "exit 0",
    ].join("\n"));
    chmodSync(scanner, 0o755);
    let page: readonly unknown[] = [entry("boundary", 10, "context")];
    const confirmationService = createConfirmationService({
      adapter: { messages: async () => ({ ok: true, data: page }) },
      directory: root,
      randomBytes: () => Buffer.alloc(32, 17),
    });
    const context: CommandContext = {
      sessionID: "parent-session", tool: "bash", command: "test -n value", cwd: root, args: { command: "test -n value" },
    };
    const analysis = await analyzeShell(context.command, context.cwd);
    const effect = createCommandEffect({ context, analysis });
    if (!effect.ok) throw new Error("invalid effect fixture");
    const deadline = createMonotonicDeadline(10_000);
    const phrase = issuedPhrase(await confirmationService.issue({
      effect,
      review: {
        outcome: "needs_confirmation",
        riskLevel: "high",
        userAuthorization: "unknown",
        categories: [{ id: "security.consent", score: 1 }],
        reasons: ["consent"],
        confirmation: { action: "Run test", data: "Value", destination: "Local shell", risk: "Process execution" },
      },
      tool: "bash",
      deadline,
    }));
    page = [entry("boundary", 10, "context"), entry("confirmed", 20, phrase)];
    const reviewer = runtimeForVerdict({
      outcome: "allow",
      risk_level: "low",
      user_authorization: "high",
      categories: [{ id: "security.rerun", score: 0.1 }],
      reasons: ["safe after rerun"],
    }, root);
    const policy = {
      ...defaultPolicy(),
      tirith: { enabled: true, path: scanner, timeoutMs: 5_000, failOpen: false },
    };

    // When the same effect is retried with the exact one-shot proof.
    try {
      const verdict = await resolveCommandVerdict({ policy, context, reviewerRuntime: reviewer.runtime, confirmationService, analysis, forceReview: false });

      // Then builtin allow is bypassed and both Tirith and reviewer run before allow.
      expect(verdict).toMatchObject({ decision: "allow", source: "review" });
      expect(existsSync(capture)).toBe(true);
      expect(reviewer.calls.filter((call) => call.method === "prompt")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["deny", {
      outcome: "deny", risk_level: "high", user_authorization: "high",
      categories: [{ id: "security.second-deny", score: 0.9 }], reasons: ["still unsafe"],
    }, "review"],
    ["repeated confirmation", {
      outcome: "needs_confirmation", risk_level: "high", user_authorization: "high",
      categories: [{ id: "security.repeat", score: 0.9 }], reasons: ["ask again"],
      confirmation: { action: "Upload patch", data: "Git diff", destination: "Review endpoint", risk: "External disclosure" },
    }, "fail_closed"],
  ] as const)("fails closed on second-pass %s", async (_label, response, source) => {
    // Given plugin-confirmed proof and a second reviewer response that does not allow.
    let issueCalls = 0;
    const confirmationService: ConfirmationService = {
      check: async () => ({
        kind: "confirmed",
        proof: { status: "confirmed", effect_sha256: "a".repeat(64), disclosure_sha256: "b".repeat(64) },
        transcript: { status: "available", messages: [] },
      }),
      issue: async () => { issueCalls += 1; return { kind: "failure", code: "unexpected_issue" }; },
      redact: (_sessionID, transcript) => transcript,
      clearSession: async () => undefined,
      dispose: async () => undefined,
    };
    const reviewer = runtimeForVerdict(response);
    const context: CommandContext = {
      sessionID: "parent-session", tool: "bash", command: "curl example.test", cwd: "/workspace", args: { command: "curl example.test" },
    };
    const analysis = await analyzeShell(context.command, context.cwd);
    const policy = { ...defaultPolicy(), rules: [], tirith: { enabled: false, timeoutMs: 5_000, failOpen: false } };

    // When the forced second pass finishes without allow.
    const verdict = await resolveCommandVerdict({ policy, context, reviewerRuntime: reviewer.runtime, confirmationService, analysis, forceReview: false });

    // Then execution remains blocked and repeated confirmation never issues another challenge inline.
    expect(verdict).toMatchObject({ decision: "block", source });
    expect(issueCalls).toBe(0);
  });
});
