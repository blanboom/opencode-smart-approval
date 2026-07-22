import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createMonotonicDeadline } from "../../src/bounded-race";
import { CONFIRMATION_TTL_MS, createConfirmationService } from "../../src/confirmation-service";
import { CONFIRMATION_REDACTION_TTL_MS } from "../../src/confirmation-ledger";
import { redactKnownConfirmationTokens } from "../../src/confirmation-redaction";
import { serializeReviewRequest, type SerializeReviewRequestInput } from "../../src/review-request";
import type { ReviewerTranscript } from "../../src/transcript-types";
import { authorizationEntry, confirmationReview, effectFixture, issuedPhrase } from "./confirmation-service-fixture";

const REDACTED_TOKEN = "[authorization token redacted]";
const tokenFromByte = (value: number): string => Buffer.alloc(32, value).toString("base64url");
const digest = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();
const transcriptWith = (role: "user" | "assistant", text: string): ReviewerTranscript => ({
  status: "available",
  messages: [{ role, parts: [{ type: "text", text }] }],
});

type RequestFactory = (args?: unknown) => SerializeReviewRequestInput;

export const registerConfirmationRedactionTests = (requestInput: RequestFactory): void => {
  describe("confirmation token redaction boundary", () => {
    test.each([
      ["at the start", (token: string) => `${token}!`],
      ["in the middle", (token: string) => `before(${token})after`],
      ["at the end", (token: string) => `!${token}`],
      ["beside letters", (token: string) => `prefix${token}suffix`],
      ["beside digits", (token: string) => `7${token}9`],
      ["beside hyphens", (token: string) => `-${token}-`],
      ["beside underscores", (token: string) => `_${token}_`],
    ] as const)("redacts a matching 43-character window %s", (_label, embed) => {
      // Given one retained token hash and a user copy at the named occurrence position.
      const token = tokenFromByte(17);
      const transcript = transcriptWith("user", embed(token));

      // When the transcript crosses the direct confirmation-redaction boundary.
      const output = redactKnownConfirmationTokens(transcript, [digest(token)]);
      const json = JSON.stringify(output);

      // Then the exact raw window is absent even when base64url characters touch it.
      expect(json.includes(token)).toBe(false);
      expect(json.includes(REDACTED_TOKEN)).toBe(true);
    });

    test("redacts every quoted, embedded, repeated, and overlapping-looking user and assistant copy", () => {
      // Given exact token copies in both roles, including a full phrase and one uninterrupted double-token run.
      const token = tokenFromByte(18);
      const transcript: ReviewerTranscript = {
        status: "available",
        messages: [
          { role: "user", parts: [
            { type: "text", text: `quoted \"${token}\" and embedded user${token}copy` },
            { type: "text", text: `AUTHORIZE opencode-smart-approval ${token}` },
          ] },
          { role: "assistant", parts: [
            { type: "text", text: `assistant${token}copy` },
            { type: "text", text: `A${token}${token}Z` },
          ] },
        ],
      };

      // When all text parts cross the direct boundary.
      const output = redactKnownConfirmationTokens(transcript, [digest(token)]);
      const json = JSON.stringify(output);

      // Then no occurrence survives and both phrase and bare-token markers are present.
      expect(json.includes(token)).toBe(false);
      expect(json.includes("[authorization phrase redacted]")).toBe(true);
      expect(json.includes(REDACTED_TOKEN)).toBe(true);
    });

    test("leaves nonmatching 43-character base64url candidates unchanged", () => {
      // Given one known hash and a different token-shaped candidate.
      const token = tokenFromByte(19);
      const other = "Z".repeat(43);

      // When the candidate crosses the direct boundary.
      const output = redactKnownConfirmationTokens(transcriptWith("assistant", `prefix${other}suffix`), [digest(token)]);

      // Then hash mismatch preserves the unrelated candidate byte-for-byte.
      expect(JSON.stringify(output).includes(other)).toBe(true);
    });

    test("keeps active and recent lifecycle tokens out of the serialized child request", async () => {
      // Given replaced, rejected, consumed, expired-recent, and active entries in one hash-only FIFO.
      let now = 100;
      let randomByte = 20;
      let page: readonly unknown[] = [];
      const service = createConfirmationService({
        adapter: { messages: async () => ({ ok: true, data: page }) },
        directory: "/workspace",
        now: () => now,
        randomBytes: () => Buffer.alloc(32, randomByte),
      });
      const deadline = () => createMonotonicDeadline(10_000, () => now);
      const issue = async (sequence: number) => {
        page = [authorizationEntry(`boundary-${sequence}`, sequence * 10, "context")];
        randomByte += 1;
        const effect = await effectFixture(`curl https://review.example.test/${sequence}`);
        const phrase = issuedPhrase(await service.issue({
          effect,
          review: confirmationReview(),
          tool: "bash",
          deadline: deadline(),
        }));
        return { effect, phrase, token: phrase.slice(-43) };
      };

      try {
        const replaced = await issue(1);
        const rejected = await issue(2);
        page = [authorizationEntry("boundary-2", 20, "context"), authorizationEntry("reject", 21, "not authorization")];
        expect(await service.check({ effect: rejected.effect, deadline: deadline() })).toEqual({ kind: "rejected", code: "phrase_mismatch" });

        const consumed = await issue(3);
        page = [authorizationEntry("boundary-3", 30, "context"), authorizationEntry("consume", 31, consumed.phrase)];
        expect((await service.check({ effect: consumed.effect, deadline: deadline() })).kind).toBe("confirmed");

        const expired = await issue(4);
        now += CONFIRMATION_TTL_MS;
        expect(await service.check({ effect: expired.effect, deadline: deadline() })).toEqual({ kind: "rejected", code: "expired" });
        const active = await issue(5);
        const tokens = [replaced.token, rejected.token, consumed.token, expired.token, active.token];
        const other = "Z".repeat(43);
        const transcript: ReviewerTranscript = {
          status: "available",
          messages: [
            { role: "user", parts: [
              { type: "text", text: `${replaced.token}suffix prefix${rejected.token}suffix` },
              { type: "text", text: `quoted \"${consumed.token}\" and -${expired.token}-` },
            ] },
            { role: "assistant", parts: [
              { type: "text", text: `_${active.token}_ ${active.token}${active.token}` },
              { type: "text", text: `${consumed.phrase} unrelated=${other}` },
            ] },
          ],
        };

        // When service redaction is followed by the exact ReviewRequest serialization boundary.
        const redacted = service.redact("parent-session", transcript);
        const request = serializeReviewRequest({ ...requestInput(), transcript: redacted });
        expect(request.ok).toBe(true);
        if (!request.ok) throw new Error("expected serialized review request");
        const redactedJson = JSON.stringify(redacted);

        // Then every active/recent raw token is absent from both boundaries and an unrelated candidate remains.
        expect(tokens.some((token) => redactedJson.includes(token))).toBe(false);
        expect(tokens.some((token) => request.json.includes(token))).toBe(false);
        expect(request.json.includes(other)).toBe(true);
      } finally {
        await service.dispose();
      }
    });

    test.each([
      ["limit-1", CONFIRMATION_TTL_MS - 1, { kind: "awaiting" }],
      ["limit", CONFIRMATION_TTL_MS, { kind: "rejected", code: "expired" }],
      ["limit+1", CONFIRMATION_TTL_MS + 1, { kind: "rejected", code: "expired" }],
    ] as const)("enforces pending confirmation TTL at %s", async (_label, elapsed, expected) => {
      // Given a challenge issued at a fixed monotonic instant.
      const issuedAt = 100;
      const page = [authorizationEntry("boundary", 10, "context")];
      const service = createConfirmationService({
        adapter: { messages: async () => ({ ok: true, data: page }) },
        directory: "/workspace",
        randomBytes: () => Buffer.alloc(32, 25),
      });
      const effect = await effectFixture();
      await service.issue({
        effect,
        review: confirmationReview(),
        tool: "bash",
        deadline: createMonotonicDeadline(10_000, () => issuedAt),
      });

      // When the same effect is checked at the exact pending-TTL boundary row.
      const result = await service.check({
        effect,
        deadline: createMonotonicDeadline(10_000, () => issuedAt + elapsed),
      });

      // Then only limit-1 remains pending and limit or later is expired.
      expect(result).toEqual(expected);
      await service.dispose();
    });

    test.each([
      ["limit-1", CONFIRMATION_REDACTION_TTL_MS - 1, false],
      ["limit", CONFIRMATION_REDACTION_TTL_MS, true],
      ["limit+1", CONFIRMATION_REDACTION_TTL_MS + 1, true],
    ] as const)("enforces redaction history TTL at %s", async (_label, elapsed, rawPresent) => {
      // Given a challenge whose hash enters the 24-hour redaction FIFO at a fixed instant.
      const issuedAt = 100;
      let now = issuedAt;
      const service = createConfirmationService({
        adapter: { messages: async () => ({ ok: true, data: [authorizationEntry("boundary", 10, "context")] }) },
        directory: "/workspace",
        now: () => now,
        randomBytes: () => Buffer.alloc(32, 26),
      });
      const effect = await effectFixture();
      const token = issuedPhrase(await service.issue({
        effect,
        review: confirmationReview(),
        tool: "bash",
        deadline: createMonotonicDeadline(10_000, () => issuedAt),
      })).slice(-43);

      // When the known token is redacted at the exact history-TTL boundary row.
      now = issuedAt + elapsed;
      const output = service.redact("parent-session", transcriptWith("user", `prefix${token}suffix`));

      // Then limit-1 is redacted while limit and later have been pruned and zeroed.
      expect(JSON.stringify(output).includes(token)).toBe(rawPresent);
      await service.dispose();
    });
  });
};
