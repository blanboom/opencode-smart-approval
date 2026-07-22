import {
  REVIEW_CHILD_ID,
  REVIEW_MESSAGE_ID,
  validPromptResponse,
  validStepFinishPart,
} from "./opencode-review-fixtures";

const withAssistant = (override: Readonly<Record<string, unknown>>) => {
  const response = validPromptResponse();
  return { ...response, info: { ...response.info, ...override } };
};

const withAssistantTotal = (total: unknown) => {
  const response = validPromptResponse();
  return { ...response, info: { ...response.info, tokens: { ...response.info.tokens, total } } };
};

const withStepFinish = (override: Readonly<Record<string, unknown>>) => {
  const response = validPromptResponse();
  return {
    ...response,
    parts: [...response.parts.slice(0, -1), { ...validStepFinishPart(), ...override }],
  };
};

const withStepFinishTotal = (total: unknown) => withStepFinish({
  tokens: { ...validStepFinishPart().tokens, total },
});

export const invalidSourceResponseCases = () => [
  ["assistant total string", () => withAssistantTotal("3")],
  ["assistant total negative", () => withAssistantTotal(-1)],
  ["assistant total NaN", () => withAssistantTotal(Number.NaN)],
  ["assistant total infinity", () => withAssistantTotal(Number.POSITIVE_INFINITY)],
  ["step total string", () => withStepFinishTotal("3")],
  ["step total negative", () => withStepFinishTotal(-1)],
  ["step total NaN", () => withStepFinishTotal(Number.NaN)],
  ["step total infinity", () => withStepFinishTotal(Number.POSITIVE_INFINITY)],
  ["variant null", () => withAssistant({ variant: null })],
  ["variant number", () => withAssistant({ variant: 3 })],
  ["non-JSON structured", () => withAssistant({ structured: BigInt(1) })],
  ["assistant unknown field", () => withAssistant({ unexpected: true })],
  ["step unknown field", () => withStepFinish({ unexpected: true })],
  ["incomplete assistant time", () => withAssistant({ time: { created: 20 } })],
  ["assistant error", () => withAssistant({ error: { name: "UnknownError", data: { message: "private" } } })],
  ["unsupported part", () => {
    const response = validPromptResponse();
    return { ...response, parts: [...response.parts, {
      id: "part-file", sessionID: REVIEW_CHILD_ID, messageID: REVIEW_MESSAGE_ID,
      type: "file", mime: "text/plain", url: "file:///tmp/private",
    }] };
  }],
] as const;
