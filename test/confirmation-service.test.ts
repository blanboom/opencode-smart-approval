import { describe, expect, test } from "bun:test";
import { createMonotonicDeadline } from "../src/bounded-race";
import { createCommandEffect } from "../src/command-effect";
import { createConfirmationService } from "../src/confirmation-service";
import { analyzeShell } from "../src/shell-analysis";
import { assistantEntryFixture, textPartFixture, userEntryFixture } from "./fixtures/transcript-fixtures";
import { authorizationEntry, confirmationReview, effectFixture, issuedPhrase } from "./fixtures/confirmation-service-fixture";

describe("one-shot confirmation service", () => {
  test("issues once, awaits without rotation, consumes exact post-boundary authorization, and rejects replay state", async () => {
    // Given a stable effect, deterministic cryptographic bytes, and one source-ordered boundary page.
    let page: readonly unknown[] = [authorizationEntry("boundary", 10, "context")];
    let randomCalls = 0;
    const service = createConfirmationService({
      adapter: { messages: async () => ({ ok: true, data: page }) },
      directory: "/workspace",
      randomBytes: () => { randomCalls += 1; return Buffer.alloc(32, 7); },
    });
    const effect = await effectFixture();
    const deadline = createMonotonicDeadline(10_000, () => 100);

    // When the challenge is issued, retried without a user message, then answered exactly once.
    const issued = await service.issue({ effect, review: confirmationReview(), tool: "bash", deadline });
    if (issued.kind !== "error") throw new Error("challenge was not issued");
    const phrase = issued.error.message.match(/AUTHORIZE opencode-smart-approval [A-Za-z0-9_-]{43}/u)?.[0];
    if (!phrase) throw new Error("missing authorization phrase");
    const awaiting = await service.check({ effect, deadline });
    page = [authorizationEntry("boundary", 10, "context"), authorizationEntry("confirmed", 20, phrase)];
    const confirmed = await service.check({ effect, deadline });
    const replay = await service.check({ effect, deadline });

    // Then only one token was generated, proof is hash-only, and consumed text is replaced for review.
    expect(randomCalls).toBe(1);
    expect(awaiting).toEqual({ kind: "awaiting" });
    expect(confirmed.kind).toBe("confirmed");
    if (confirmed.kind !== "confirmed") return;
    expect(confirmed.proof).toEqual({
      status: "confirmed",
      effect_sha256: effect.sha256,
      disclosure_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(confirmed)).not.toContain(phrase);
    expect(JSON.stringify(confirmed.transcript)).toContain("[explicit authorization confirmed by plugin]");
    expect(replay).toEqual({ kind: "none" });
  });

  test("ignores post-boundary assistant turns before one exact ordinary user authorization", async () => {
    // Given OpenCode appends an assistant final turn after the challenged tool call and before the user's exact reply.
    let page: readonly unknown[] = [authorizationEntry("boundary", 10, "context")];
    const service = createConfirmationService({
      adapter: { messages: async () => ({ ok: true, data: page }) },
      directory: "/workspace",
      randomBytes: () => Buffer.alloc(32, 8),
    });
    const effect = await effectFixture();
    const deadline = createMonotonicDeadline(10_000, () => 100);
    const phrase = issuedPhrase(await service.issue({ effect, review: confirmationReview(), tool: "bash", deadline }));
    page = [
      authorizationEntry("boundary", 10, "context"),
      assistantEntryFixture({ id: "assistant-final", created: 20 }),
      authorizationEntry("confirmed", 30, phrase),
    ];

    // When the pending generation validates the complete post-boundary transcript.
    const result = await service.check({ effect, deadline });

    // Then assistant prose is context only and the sole ordinary user reply consumes the challenge.
    expect(result.kind).toBe("confirmed");
  });

  test("atomically replaces generations and retains rejected tokens only for transcript redaction", async () => {
    // Given one issued challenge and a different effect that requests a replacement.
    let page: readonly unknown[] = [authorizationEntry("boundary", 10, "context")];
    const service = createConfirmationService({
      adapter: { messages: async () => ({ ok: true, data: page }) },
      directory: "/workspace",
      randomBytes: () => Buffer.alloc(32, 9),
    });
    const firstEffect = await effectFixture();
    const secondEffect = await effectFixture("curl https://review.example.test/other");
    const deadline = createMonotonicDeadline(10_000, () => 100);
    const first = await service.issue({ effect: firstEffect, review: confirmationReview(), tool: "bash", deadline });
    const second = await service.issue({ effect: secondEffect, review: confirmationReview(), tool: "bash", deadline });
    if (first.kind !== "error" || second.kind !== "error") throw new Error("challenge was not issued");
    const token = first.error.message.match(/AUTHORIZE opencode-smart-approval ([A-Za-z0-9_-]{43})/u)?.[1];
    if (!token) throw new Error("missing first token");
    page = [authorizationEntry("boundary", 10, "context"), authorizationEntry("wrong", 20, `AUTHORIZE opencode-smart-approval ${token}`)];

    // When the replaced effect is checked and a later transcript contains its bare token.
    const firstCheck = await service.check({ effect: firstEffect, deadline });
    const redacted = service.redact("parent-session", {
      status: "available",
      messages: [{ role: "assistant", parts: [{ type: "text", text: `quoted(${token})` }] }],
    });

    // Then replacement is explicit, the old effect cannot consume, and the token remains hash-redacted.
    expect(second.error.message).toContain("prior_challenge_replaced=true");
    expect(firstCheck).toEqual({ kind: "none" });
    expect(JSON.stringify(redacted)).not.toContain(token);
  });

  test("binds authorization to every tool argument, not only command and cwd", async () => {
    // Given two effects with the same command/cwd but a distinct non-command execution argument.
    const command = "curl https://review.example.test/upload";
    const analysis = await analyzeShell(command, "/workspace");
    const baseContext = {
      sessionID: "parent-session",
      tool: "bash",
      command,
      cwd: "/workspace",
      args: { command, description: "Upload patch", timeout: 1_000, workdir: "/workspace" },
    };
    const original = createCommandEffect({ context: baseContext, analysis });
    const changed = createCommandEffect({
      context: { ...baseContext, args: { ...baseContext.args, timeout: 2_000 } },
      analysis,
    });
    if (!original.ok || !changed.ok) throw new Error("invalid effect fixture");
    let page: readonly unknown[] = [authorizationEntry("boundary", 10, "context")];
    const service = createConfirmationService({
      adapter: { messages: async () => ({ ok: true, data: page }) },
      directory: "/workspace",
      randomBytes: () => Buffer.alloc(32, 10),
    });
    const deadline = createMonotonicDeadline(10_000, () => 100);
    const phrase = issuedPhrase(await service.issue({ effect: original, review: confirmationReview(), tool: "bash", deadline }));
    page = [authorizationEntry("boundary", 10, "context"), authorizationEntry("confirmed", 20, phrase)];

    // When the same token is checked against the changed args and then the exact original effect.
    const changedCheck = await service.check({ effect: changed, deadline });
    const originalCheck = await service.check({ effect: original, deadline });

    // Then changed args cannot consume the token and the exact full effect consumes it once.
    expect(changedCheck).toEqual({ kind: "none" });
    expect(originalCheck.kind).toBe("confirmed");
  });

  test.each([
    ["malformed boundary", [authorizationEntry("newer", 20, "newer"), authorizationEntry("older", 10, "older")], "curl https://review.example.test/upload", "authorization_boundary_unavailable"],
    ["render failure", [authorizationEntry("boundary", 10, "context")], "x".repeat(8_193), "confirmation_render_failed"],
  ] as const)("rejects %s before RNG or state", async (_label, page, command, code) => {
    // Given either inverted source order or a disclosure that exceeds its fixed cap.
    let randomCalls = 0;
    const service = createConfirmationService({
      adapter: { messages: async () => ({ ok: true, data: page }) },
      directory: "/workspace",
      randomBytes: () => { randomCalls += 1; return Buffer.alloc(32); },
    });
    const effect = await effectFixture(command);
    const deadline = createMonotonicDeadline(10_000, () => 100);

    // When issuance validates rendering and then its source boundary before token generation.
    const result = await service.issue({ effect, review: confirmationReview(), tool: "bash", deadline });

    // Then the named fixed failure contains no challenge and neither RNG nor pending state exists.
    expect(result).toEqual({ kind: "failure", code });
    expect(randomCalls).toBe(0);
    expect(await service.check({ effect, deadline })).toEqual({ kind: "none" });
  });

});
