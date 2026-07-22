import { describe, expect, test } from "bun:test";
import {
  parseConfirmationChallenge,
  parseExecutionSummary,
  requireAuthorizationFailure,
  requireConfirmedReviewerRequest,
} from "../scripts/opencode-e2e/confirmation";
import {
  appendBoundaryFillers,
  requireBoundaryEvictionTranscript,
} from "../scripts/opencode-e2e/confirmation-boundary";
import { cappedJson } from "../scripts/opencode-e2e/reporting";

const token = "a".repeat(43);
const phrase = `AUTHORIZE opencode-smart-approval ${token}`;
const effect = "b".repeat(64);
const disclosure = "c".repeat(64);
const challengeError = [
  "[CommandApproval]",
  "decision=block",
  `effect_sha256=${effect}`,
  `disclosure_sha256=${disclosure}`,
  "prior_challenge_replaced=false",
  `authorization_phrase=${phrase}`,
].join("\n");

const toolPart = (status: "completed" | "error", command: string, value: string) => ({
  type: "tool",
  tool: "bash",
  state: status === "completed"
    ? { status, input: { command }, output: value }
    : { status, input: { command }, error: value },
});

const transcriptMessage = (
  index: number,
  role: "user" | "assistant",
  parts: readonly unknown[],
) => ({
  info: {
    id: `msg_${String(index).padStart(3, "0")}`,
    sessionID: "ses_parent",
    role,
    time: { created: index },
  },
  parts,
});

const boundaryTranscript = (): readonly unknown[] => [
  transcriptMessage(0, "user", [{ type: "text", text: "initial" }]),
  transcriptMessage(1, "assistant", [toolPart("error", "printf guarded", challengeError)]),
  transcriptMessage(2, "assistant", [{ type: "text", text: "blocked" }]),
  ...Array.from(
    { length: 33 },
    (_value, index) => transcriptMessage(index + 3, "user", [{ type: "text", text: `boundary filler ${String(index)}` }]),
  ),
  transcriptMessage(36, "user", [{ type: "text", text: phrase }]),
  transcriptMessage(37, "assistant", [toolPart("error", "printf guarded", "reviewer_failure:boundary_mismatch")]),
  transcriptMessage(38, "assistant", [{ type: "text", text: "blocked" }]),
];

describe("live confirmation E2E receipts", () => {
  test("extracts one exact challenge and rejects ambiguous disclosure material", () => {
    // Given a parent transcript containing one failed command with the complete disclosure challenge.
    const messages = [{ info: { sessionID: "ses_parent" }, parts: [toolPart("error", "printf guarded", challengeError)] }];

    // When the harness parses the challenge by exact session and command.
    const challenge = parseConfirmationChallenge(messages, "ses_parent", "printf guarded");

    // Then the phrase, hashes, and replacement bit are retained as typed values only once.
    expect(challenge).toEqual({ phrase, token, effectSha256: effect, disclosureSha256: disclosure, replaced: false });
    expect(() => parseConfirmationChallenge([...messages, ...messages], "ses_parent", "printf guarded")).toThrow("sdk_malformed");
  });

  test("counts completed command execution independently from blocked attempts", () => {
    // Given one challenged attempt, one completed retry, and one replay rejection.
    const messages = [{
      info: { sessionID: "ses_parent" },
      parts: [
        toolPart("error", "printf guarded", challengeError),
        toolPart("completed", "printf guarded", "done"),
        toolPart("error", "printf guarded", "reviewer_failure:authorization_phrase_mismatch"),
      ],
    }];

    // When command attempts are summarized from source-runtime tool states.
    const summary = parseExecutionSummary(messages, "ses_parent", ["printf guarded"]);

    // Then exactly one execution is distinguished from both blocked attempts.
    expect(summary).toEqual({ completed: 1, errors: 2, commands: ["printf guarded", "printf guarded", "printf guarded"] });
    expect(requireAuthorizationFailure(messages, "ses_parent", "printf guarded", "phrase_mismatch")).toBe(true);
  });

  test("accepts a hash-only confirmed reviewer request and rejects raw challenge leakage", () => {
    // Given the second reviewer request contains confirmed hashes and the redacted transcript marker.
    const request = {
      input: [{
        role: "user",
        content: JSON.stringify({
          authorization_proof: { status: "confirmed", effect_sha256: effect, disclosure_sha256: disclosure },
          transcript: { messages: [{ text: "[explicit authorization confirmed by plugin]" }] },
        }),
      }],
    };
    const challenge = { phrase, token, effectSha256: effect, disclosureSha256: disclosure, replaced: false } as const;

    // When the structural request boundary validates the second review payload.
    const receipt = requireConfirmedReviewerRequest(request, challenge);

    // Then only hash proof and redacted bounded context are accepted.
    expect(receipt).toEqual({ effectSha256: effect, disclosureSha256: disclosure, rawPhraseAbsent: true });
    expect(() => requireConfirmedReviewerRequest({ input: [{ content: phrase }] }, challenge)).toThrow("provider_request");
  });

  test("redacts authorization phrases from bounded failure evidence", () => {
    // Given a failed live scenario capture contains a real authorization phrase and the private temporary root.
    const capture = { error: `failed at /private/tmp/e2e with ${phrase}` };

    // When the harness serializes bounded diagnostic evidence.
    const serialized = cappedJson(capture, "/private/tmp/e2e", 4_096);

    // Then the root and complete authorization phrase are absent while the failure remains diagnosable.
    expect(serialized).not.toContain("/private/tmp/e2e");
    expect(serialized).not.toContain(phrase);
    expect(serialized).toContain("<authorization-phrase>");
  });

  test("persists thirty-three ordinary fillers in exact logical order", async () => {
    // Given a no-reply append seam that reverses every simultaneously pending completion.
    const pending: Array<Readonly<{ complete: () => void; text: string }>> = [];
    const persisted: string[] = [];
    let maximumPending = 0;

    // When the boundary filler helper sends every required ordinary message.
    const receipt = await appendBoundaryFillers((text) => new Promise<void>((complete) => {
      pending.push({ complete, text });
      maximumPending = Math.max(maximumPending, pending.length);
      queueMicrotask(() => {
        const completing = pending.splice(0).reverse();
        for (const entry of completing) {
          persisted.push(entry.text);
          entry.complete();
        }
      });
    }));

    // Then no simultaneous sends can reverse persistence and all thirty-three remain source ordered.
    const expected = Array.from({ length: 33 }, (_value, index) => `boundary filler ${String(index)}`);
    expect(persisted).toEqual(expected);
    expect(receipt.fillerCount).toBe(33);
    expect(receipt.batchSize).toBe(1);
    expect(receipt.batchDurationsMilliseconds).toHaveLength(33);
    expect(maximumPending).toBe(1);
  });

  test("requires the exact ordered eviction transcript and rejects a synthetic filler", () => {
    // Given thirty-nine source-ordered messages whose latest twenty omit the original challenge disclosure.
    const transcript = boundaryTranscript();

    // When the complete transcript and latest-page eviction contract are checked together.
    const receipt = requireBoundaryEvictionTranscript(transcript, "ses_parent", phrase);

    // Then all fillers remain ordinary and ordered while the challenge is absent from the latest page.
    expect(receipt).toEqual({
      challengeBoundaryAbsent: true,
      fillerOrder: Array.from({ length: 33 }, (_value, index) => index),
      latestPageCount: 20,
      messageCount: 39,
    });
    const malformed = structuredClone(transcript);
    const filler = malformed[3] as { parts: Array<Record<string, unknown>> };
    filler.parts[0] = { ...filler.parts[0], synthetic: true };
    expect(() => requireBoundaryEvictionTranscript(malformed, "ses_parent", phrase)).toThrow("sdk_malformed");
  });
});
