import { mock } from "bun:test";
import type { CommandContext, ResolvedPolicy, RuleEvaluation } from "../../src/types";

let lastGenerateOptions: unknown;
let generatedTexts: string[] = [];
let generateCallCount = 0;

mock.module("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: () => ({
    chatModel: (model: string) => ({ model }),
  }),
}));

mock.module("ai", () => ({
  generateText: mock(async (options: unknown) => {
    lastGenerateOptions = options;
    generateCallCount += 1;
    return {
      text: generatedTexts.shift() ?? JSON.stringify({
        outcome: "allow",
        risk_level: "low",
        user_authorization: "high",
        categories: [{ id: "security.test", score: 0 }],
        reasons: ["test approval"],
      }),
    };
  }),
  isStepCount: (count: number) => ({ count }),
  zodSchema: (schema: unknown) => schema,
}));

const policy = (maxRetries: number): ResolvedPolicy => ({
  review: {
    baseURL: "https://example.com/v1",
    apiKey: "test-key",
    model: "test-model",
    timeoutMs: 45_000,
    maxScriptBytes: 20_000,
    maxToolCalls: 0,
    maxRetries,
    contextMessages: 0,
    prompt: "Return JSON.",
  },
  riskTool: { enabled: false, timeoutMs: 5_000, failOpen: true },
  selfProtection: { enabled: true },
  rules: [],
});

const context: CommandContext = {
  sessionID: "session-test",
  tool: "bash",
  command: "git push",
  cwd: process.cwd(),
  args: {},
  scriptEvidence: [],
};

const evaluation: RuleEvaluation = {
  decision: "review",
  matchedRules: [],
  categories: [],
  reasons: [],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const { reviewWithAiSdk } = await import("../../src/reviewer");
await reviewWithAiSdk(policy(5), context, evaluation, "");
if (!isRecord(lastGenerateOptions) || typeof lastGenerateOptions["maxRetries"] !== "number") {
  throw new TypeError("generateText retry options were not captured");
}
const configuredRetryCount = lastGenerateOptions["maxRetries"];

generatedTexts = [
  '{"outcome":"allow"',
  JSON.stringify({
    outcome: "deny",
    risk_level: "high",
    user_authorization: "unknown",
    categories: [{ id: "security.retry", score: 1 }],
    reasons: ["retry produced a complete decision"],
  }),
];
generateCallCount = 0;
const malformed = await reviewWithAiSdk(policy(5), context, evaluation, "");
const malformedCallCount = generateCallCount;

generatedTexts = ['{"outcome":"allow"'];
generateCallCount = 0;
const noRetry = await reviewWithAiSdk(policy(0), context, evaluation, "");

console.log(JSON.stringify({
  configuredRetryCount,
  malformedCallCount,
  malformedOutcome: malformed.outcome,
  malformedReasons: malformed.reasons,
  noRetryCallCount: generateCallCount,
  noRetryOutcome: noRetry.outcome,
  noRetryReasons: noRetry.reasons,
}));
