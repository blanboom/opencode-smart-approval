import type { ConfirmationService } from "../../src/confirmation-service";
import { expectedAgentFixture, validCreatedSession, validPromptResponse } from "./opencode-review-fixtures";
import { reviewRuntimeFixture } from "./opencode-review-runtime";
import { textPartFixture, userEntryFixture } from "./transcript-fixtures";

export const confirmationEntry = (id: string, created: number, text: string) => userEntryFixture({
  id,
  created,
  parts: [textPartFixture({ id: `${id}-part`, messageID: id, text })],
});

export const inputStringField = (input: unknown, name: string): string | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const value = Reflect.get(input, name);
  return typeof value === "string" ? value : undefined;
};

export const issuedConfirmationPhrase = (result: Awaited<ReturnType<ConfirmationService["issue"]>>): string => {
  if (result.kind !== "error") throw new Error("challenge was not issued");
  const phrase = result.error.message.match(/AUTHORIZE opencode-smart-approval [A-Za-z0-9_-]{43}/u)?.[0];
  if (!phrase) throw new Error("missing authorization phrase");
  return phrase;
};

export const runtimeForConfirmationVerdict = (verdict: unknown, directory = "/workspace") => {
  const expected = expectedAgentFixture();
  return reviewRuntimeFixture(async (method, input) => {
    if (method === "agents") return { ok: true, data: [expected.runtime] };
    if (method === "create") return { ok: true, data: { ...validCreatedSession(), directory } };
    if (method === "prompt") {
      const childID = inputStringField(input, "sessionID") ?? "child-session";
      const response = validPromptResponse(verdict);
      const messageID = `assistant-${childID}`;
      return {
        ok: true,
        data: {
          ...response,
          info: { ...response.info, id: messageID, sessionID: childID, path: { cwd: directory, root: directory } },
          parts: response.parts.map((part) => ({ ...part, sessionID: childID, messageID })),
        },
      };
    }
    if (method === "delete") return { ok: true, data: true };
    return { ok: false, code: "sdk_error" };
  }, { directory, worktree: directory });
};
