import { createHash, timingSafeEqual } from "node:crypto";
import { redactReviewerTranscript } from "./transcript-projector";
import type { ReviewerTranscript } from "./transcript-types";

const TOKEN_LENGTH = 43;
const REDACTED_TOKEN = "[authorization token redacted]";

const tokenMatches = (token: string, hashes: readonly Uint8Array[]): boolean => {
  const candidate = createHash("sha256").update(token, "utf8").digest();
  let matched = 0;
  for (const hash of hashes) {
    const sameLength = hash.byteLength === candidate.byteLength;
    const comparable = sameLength ? hash : new Uint8Array(candidate.byteLength);
    const equal = timingSafeEqual(candidate, comparable);
    matched |= Number(sameLength && equal);
  }
  candidate.fill(0);
  return matched === 1;
};

const isBase64Url = (code: number): boolean => (
  (code >= 48 && code <= 57)
  || (code >= 65 && code <= 90)
  || (code >= 97 && code <= 122)
  || code === 45
  || code === 95
);

const redactTokenWindows = (text: string, hashes: readonly Uint8Array[]): string => {
  const matchedStarts: number[] = [];
  let runLength = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (isBase64Url(text.charCodeAt(index))) runLength += 1;
    else runLength = 0;
    if (runLength < TOKEN_LENGTH) continue;
    const start = index - TOKEN_LENGTH + 1;
    if (tokenMatches(text.slice(start, index + 1), hashes)) matchedStarts.push(start);
  }
  if (matchedStarts.length === 0) return text;

  let output = "";
  let copiedThrough = 0;
  for (const start of matchedStarts) {
    const end = start + TOKEN_LENGTH;
    if (start < copiedThrough) {
      copiedThrough = Math.max(copiedThrough, end);
      continue;
    }
    output += text.slice(copiedThrough, start) + REDACTED_TOKEN;
    copiedThrough = end;
  }
  return output + text.slice(copiedThrough);
};

export const redactKnownConfirmationTokens = (
  transcript: ReviewerTranscript,
  hashes: readonly Uint8Array[],
): ReviewerTranscript => {
  const phrasesRedacted = redactReviewerTranscript(transcript);
  if (phrasesRedacted.status !== "available" || hashes.length === 0) return phrasesRedacted;
  return Object.freeze({
    status: "available",
    messages: Object.freeze(phrasesRedacted.messages.map((message) => Object.freeze({
      role: message.role,
      parts: Object.freeze(message.parts.map((part) => part.type === "text"
        ? Object.freeze({
            type: "text",
            text: redactTokenWindows(part.text, hashes),
          })
        : part)),
    }))),
  });
};
