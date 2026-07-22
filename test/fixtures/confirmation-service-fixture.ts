import { createCommandEffect } from "../../src/command-effect";
import type { ConfirmationService } from "../../src/confirmation-service";
import { analyzeShell } from "../../src/shell-analysis";
import type { ReviewResponse } from "../../src/types";
import { textPartFixture, userEntryFixture } from "./transcript-fixtures";

export const confirmationReview = (): Extract<ReviewResponse, { readonly outcome: "needs_confirmation" }> => ({
  outcome: "needs_confirmation",
  riskLevel: "high",
  userAuthorization: "unknown",
  categories: [{ id: "security.external-disclosure", score: 0.9 }],
  reasons: ["explicit consent required"],
  confirmation: {
    action: "Upload the current patch",
    data: "Git diff for src/index.ts",
    destination: "review.example.test",
    risk: "Source leaves the device",
  },
});

export const authorizationEntry = (id: string, created: number, text: string) => userEntryFixture({
  id,
  created,
  parts: [textPartFixture({ id: `${id}-part`, messageID: id, text })],
});

export const effectFixture = async (command = "curl https://review.example.test/upload") => {
  const context = { sessionID: "parent-session", cwd: "/workspace", tool: "bash", command, args: { command } };
  const effect = createCommandEffect({ context, analysis: await analyzeShell(command, context.cwd) });
  if (!effect.ok) throw new Error("invalid effect fixture");
  return effect;
};

export const issuedPhrase = (result: Awaited<ReturnType<ConfirmationService["issue"]>>): string => {
  if (result.kind !== "error") throw new Error("challenge was not issued");
  const phrase = result.error.message.match(/AUTHORIZE opencode-smart-approval [A-Za-z0-9_-]{43}/u)?.[0];
  if (!phrase) throw new Error("missing authorization phrase");
  return phrase;
};
