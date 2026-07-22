import { describe, expect, test } from "bun:test";
import { policyFromUnknown } from "../src/policy-parser";

const minimalPolicy = { version: 3, review: {} } as const;

describe("policy v3 legacy rejection", () => {
  test.each([
    ["base_url", { review: { base_url: "https://example.invalid/v1" } }, "review.base_url"],
    ["baseURL", { review: { baseURL: "https://example.invalid/v1" } }, "review.baseURL"],
    ["api_key", { review: { api_key: "secret" } }, "review.api_key"],
    ["apiKey", { review: { apiKey: "secret" } }, "review.apiKey"],
    ["timeoutMs", { review: { timeoutMs: 45_000 } }, "review.timeoutMs"],
    ["contextMessages", { review: { contextMessages: 20 } }, "review.contextMessages"],
    ["cleanupSession", { review: { cleanupSession: true } }, "review.cleanupSession"],
    ["cleanupEnabled", { review: { cleanupEnabled: true } }, "review.cleanupEnabled"],
    ["max_script_bytes", { review: { max_script_bytes: 20_000 } }, "review.max_script_bytes"],
    ["maxScriptBytes", { review: { maxScriptBytes: 20_000 } }, "review.maxScriptBytes"],
    ["max_tool_calls", { review: { max_tool_calls: 3 } }, "review.max_tool_calls"],
    ["maxToolCalls", { review: { maxToolCalls: 3 } }, "review.maxToolCalls"],
    ["max_retries", { review: { max_retries: 3 } }, "review.max_retries"],
    ["maxRetries", { review: { maxRetries: 3 } }, "review.maxRetries"],
    ["risk_tool", { risk_tool: { enabled: false } }, "risk_tool"],
    ["riskTool", { riskTool: { enabled: false } }, "riskTool"],
    ["allowLocalConfig", { allowLocalConfig: true }, "allowLocalConfig"],
    ["selfProtection", { selfProtection: { enabled: true } }, "selfProtection"],
    ["rules.block", { rules: { block: [] } }, "rules.block"],
    ["tirith.command", { tirith: { command: "/opt/tirith" } }, "tirith.command"],
    ["tirith.timeoutMs", { tirith: { timeoutMs: 5_000 } }, "tirith.timeoutMs"],
    ["tirith.failOpen", { tirith: { failOpen: true } }, "tirith.failOpen"],
  ])("rejects obsolete identifier %s", (_label, fragment, field) => {
    // Given a v3-looking document containing one retired identifier.
    const policy = { ...minimalPolicy, ...fragment };

    // When/Then strict parsing rejects it instead of interpreting compatibility syntax.
    expect(() => policyFromUnknown(policy, [])).toThrow(field);
  });

});
