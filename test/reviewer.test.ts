import { describe, expect, mock, test } from "bun:test";
import type { CommandContext, ResolvedPolicy, RuleEvaluation } from "../src/types";

let lastGenerateOptions: unknown;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

mock.module("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: () => ({
    chatModel: (model: string) => ({ model }),
  }),
}));

mock.module("ai", () => ({
  generateText: mock(async (options: unknown) => {
    lastGenerateOptions = options;
    return {
      text: JSON.stringify({
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
  riskTool: {
    enabled: false,
    timeoutMs: 5_000,
    failOpen: true,
  },
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

describe("AI SDK reviewer", () => {
  test("passes configured retry count to generateText", async () => {
    const { reviewWithAiSdk } = await import("../src/reviewer");
    const response = await reviewWithAiSdk(policy(5), context, evaluation, "");

    expect(response.outcome).toBe("allow");
    expect(isRecord(lastGenerateOptions)).toBe(true);
    if (!isRecord(lastGenerateOptions)) throw new TypeError("generateText options were not captured");
    expect(lastGenerateOptions["maxRetries"]).toBe(5);
  });
});
