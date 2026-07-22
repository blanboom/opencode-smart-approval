import { describe, expect, test } from "bun:test";
import { createMonotonicDeadline } from "../src/bounded-race";
import { CONFIRMATION_TTL_MS, createConfirmationService } from "../src/confirmation-service";
import { assistantEntryFixture, textPartFixture, userEntryFixture } from "./fixtures/transcript-fixtures";
import { authorizationEntry, confirmationReview, effectFixture, issuedPhrase } from "./fixtures/confirmation-service-fixture";

describe("one-shot confirmation service", () => {
  test("fails closed without pending state when cryptographic randomness fails", async () => {
    // Given a valid boundary whose cryptographic random source fails before token creation.
    const service = createConfirmationService({
      adapter: { messages: async () => ({ ok: true, data: [authorizationEntry("boundary", 10, "context")] }) },
      directory: "/workspace",
      randomBytes: () => { throw new Error("rng unavailable"); },
    });
    const effect = await effectFixture();
    const deadline = createMonotonicDeadline(10_000, () => 100);

    // When the service attempts to issue the challenge.
    const result = await service.issue({ effect, review: confirmationReview(), tool: "bash", deadline });

    // Then it reports a fixed failure and cannot later consume authorization.
    expect(result).toEqual({ kind: "failure", code: "confirmation_rng_failed" });
    expect(await service.check({ effect, deadline })).toEqual({ kind: "none" });
  });

  test("preserves a generation across transient fetch failure and serializes concurrent double use", async () => {
    // Given an issued challenge whose authorization fetch transiently fails before the exact user reply appears.
    let mode: "available" | "failed" = "available";
    let page: readonly unknown[] = [authorizationEntry("boundary", 10, "context")];
    const service = createConfirmationService({
      adapter: { messages: async () => mode === "available"
        ? { ok: true, data: page }
        : { ok: false, code: "sdk_error" } },
      directory: "/workspace",
      randomBytes: () => Buffer.alloc(32, 11),
    });
    const effect = await effectFixture();
    const deadline = createMonotonicDeadline(10_000, () => 100);
    const phrase = issuedPhrase(await service.issue({ effect, review: confirmationReview(), tool: "bash", deadline }));

    // When one fetch fails, the same phrase later appears, and two checks race for the generation.
    mode = "failed";
    const unavailable = await service.check({ effect, deadline });
    mode = "available";
    page = [authorizationEntry("boundary", 10, "context"), authorizationEntry("confirmed", 20, phrase)];
    const raced = await Promise.all([service.check({ effect, deadline }), service.check({ effect, deadline })]);

    // Then failure preserves the token and the mutex permits exactly one confirmed consume.
    expect(unavailable).toEqual({ kind: "unavailable", code: "sdk_error" });
    expect(raced.map((result) => result.kind).sort()).toEqual(["confirmed", "none"]);
  });

  test("rechecks expiry after authorization fetch immediately before token consumption", async () => {
    // Given a valid challenge whose deterministic clock crosses its TTL during the async transcript fetch.
    let now = 100;
    let expireDuringFetch = false;
    let page: readonly unknown[] = [authorizationEntry("boundary", 10, "context")];
    const service = createConfirmationService({
      adapter: { messages: async () => {
        if (expireDuringFetch) now = 100 + CONFIRMATION_TTL_MS;
        return { ok: true, data: page };
      } },
      directory: "/workspace",
      randomBytes: () => Buffer.alloc(32, 12),
    });
    const effect = await effectFixture();
    const deadline = createMonotonicDeadline(CONFIRMATION_TTL_MS + 10_000, () => now);
    const phrase = issuedPhrase(await service.issue({ effect, review: confirmationReview(), tool: "bash", deadline }));
    page = [authorizationEntry("boundary", 10, "context"), authorizationEntry("confirmed", 20, phrase)];

    // When the exact token arrives before fetch but the generation expires before locked consumption.
    expireDuringFetch = true;
    const expired = await service.check({ effect, deadline });
    const replay = await service.check({ effect, deadline });

    // Then expiry wins atomically and the token can never authorize or replay the effect.
    expect(expired).toEqual({ kind: "rejected", code: "expired" });
    expect(replay).toEqual({ kind: "none" });
  });

  test.each([
    ["missing boundary", (phrase: string) => [authorizationEntry("other", 20, phrase)], "boundary_mismatch"],
    ["changed boundary tuple", (phrase: string) => [authorizationEntry("boundary", 11, "context"), authorizationEntry("confirmed", 20, phrase)], "boundary_mismatch"],
    ["multiple newer users", (phrase: string) => [
      authorizationEntry("boundary", 10, "context"), authorizationEntry("first", 20, phrase), authorizationEntry("second", 30, phrase),
    ], "ambiguous_suffix"],
    ["synthetic user", (_phrase: string) => [authorizationEntry("boundary", 10, "context"), userEntryFixture({
      id: "synthetic", created: 20, parts: [textPartFixture({ id: "synthetic-part", messageID: "synthetic", text: "copy", synthetic: true })],
    })], "invalid_user_message"],
    ["wrong token", (_phrase: string) => [
      authorizationEntry("boundary", 10, "context"),
      authorizationEntry("wrong", 20, `AUTHORIZE opencode-smart-approval ${"Z".repeat(43)}`),
    ], "token_mismatch"],
  ] as const)("revokes on definitive %s", async (_label, suffix, code) => {
    // Given a valid challenge followed by one definitive non-confirmation suffix class.
    let page: readonly unknown[] = [authorizationEntry("boundary", 10, "context")];
    const service = createConfirmationService({
      adapter: { messages: async () => ({ ok: true, data: page }) },
      directory: "/workspace",
      randomBytes: () => Buffer.alloc(32, 13),
    });
    const effect = await effectFixture();
    const deadline = createMonotonicDeadline(10_000, () => 100);
    const phrase = issuedPhrase(await service.issue({ effect, review: confirmationReview(), tool: "bash", deadline }));
    page = suffix(phrase);

    // When the authorization validator checks the complete newer suffix.
    const result = await service.check({ effect, deadline });

    // Then the generation is revoked and cannot be consumed later.
    expect(result).toEqual({ kind: "rejected", code });
    expect(await service.check({ effect, deadline })).toEqual({ kind: "none" });
  });

  test("preserves assistant-only retries and enforces FIFO count, pending TTL, history TTL, and lifecycle clearing", async () => {
    // Given 65 replacement challenges under one session with observable monotonic time.
    let now = 100;
    let nonce = 0;
    let page: readonly unknown[] = [authorizationEntry("boundary", 10, "context")];
    const service = createConfirmationService({
      adapter: { messages: async () => ({ ok: true, data: page }) },
      directory: "/workspace",
      now: () => now,
      randomBytes: () => {
        const bytes = Buffer.alloc(32);
        bytes.writeUInt32BE(nonce, 28);
        nonce += 1;
        return bytes;
      },
    });
    const effect = await effectFixture();
    const phrases: string[] = [];
    for (let index = 0; index < 65; index += 1) {
      phrases.push(issuedPhrase(await service.issue({
        effect,
        review: confirmationReview(),
        tool: "bash",
        deadline: createMonotonicDeadline(10_000, () => now),
      })));
    }
    const tokens = phrases.map((phrase) => phrase.slice(-43));
    page = [
      authorizationEntry("boundary", 10, "context"),
      assistantEntryFixture({ id: "assistant", created: 20, parts: [textPartFixture({ id: "assistant-part", messageID: "assistant", text: phrases.at(-1) ?? "" })] }),
    ];

    // When assistant-only retry, FIFO redaction, expiry, session clearing, and disposal are exercised.
    const awaiting = await service.check({ effect, deadline: createMonotonicDeadline(10_000, () => now) });
    const redacted = service.redact("parent-session", {
      status: "available",
      messages: [{ role: "user", parts: [{ type: "text", text: tokens.join(" ") }] }],
    });
    now += 5 * 60 * 1_000;
    const expired = await service.check({ effect, deadline: createMonotonicDeadline(10_000, () => now) });
    now += 24 * 60 * 60 * 1_000;
    const afterHistoryTtl = service.redact("parent-session", {
      status: "available",
      messages: [{ role: "user", parts: [{ type: "text", text: tokens.at(-1) ?? "" }] }],
    });
    await service.clearSession("parent-session");
    await service.dispose();
    const disposed = await service.issue({ effect, review: confirmationReview(), tool: "bash", deadline: createMonotonicDeadline(10_000, () => now) });

    // Then assistant retries await, only the newest 64 hashes redact, both TTLs expire, and lifecycle prevents new state.
    expect(awaiting).toEqual({ kind: "awaiting" });
    expect(JSON.stringify(redacted)).toContain(tokens[0] ?? "missing");
    expect(JSON.stringify(redacted)).not.toContain(tokens[1] ?? "missing");
    expect(JSON.stringify(redacted)).not.toContain(tokens.at(-1) ?? "missing");
    expect(expired).toEqual({ kind: "rejected", code: "expired" });
    expect(JSON.stringify(afterHistoryTtl)).toContain(tokens.at(-1) ?? "missing");
    expect(disposed).toEqual({ kind: "failure", code: "confirmation_disposed" });
  });
});
