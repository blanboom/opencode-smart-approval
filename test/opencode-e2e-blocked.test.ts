import { describe, expect, test } from "bun:test";
import { parseBlockedAssistant, parseBlockedTool } from "../scripts/opencode-e2e/blocked";

const errorMessage = {
  info: { role: "assistant", sessionID: "ses_primary" },
  parts: [{
    type: "tool",
    tool: "bash",
    state: { status: "error", input: { command: "printf main-ok" }, error: "approval blocked" },
  }],
};

describe("blocked inference receipts", () => {
  test("accepts one exact failed tool and a bounded final assistant text", () => {
    // Given one primary-session bash failure and one final assistant envelope.
    const assistant = { info: { role: "assistant", sessionID: "ses_primary" }, parts: [{ type: "text", text: "mutation-blocked" }] };

    // When both source-runtime envelopes cross the harness parsers.
    const tool = parseBlockedTool([errorMessage], "ses_primary", "printf main-ok");
    const final = parseBlockedAssistant(assistant, "ses_primary", "mutation-blocked");

    // Then exact failure state and ordinary text are retained without accepting execution.
    expect(tool).toEqual({ command: "printf main-ok", error: "approval blocked" });
    expect(final).toEqual({ text: "mutation-blocked" });
  });

  test("rejects a completed tool, wrong session, altered command, and oversized error", () => {
    // Given every security-relevant deviation from the blocked tool grammar.
    const calls = [
      () => parseBlockedTool([{ ...errorMessage, parts: [{ ...errorMessage.parts[0], state: { ...errorMessage.parts[0]?.state, status: "completed" } }] }], "ses_primary", "printf main-ok"),
      () => parseBlockedTool([errorMessage], "ses_other", "printf main-ok"),
      () => parseBlockedTool([errorMessage], "ses_primary", "printf changed"),
      () => parseBlockedTool([{ ...errorMessage, parts: [{ ...errorMessage.parts[0], state: { ...errorMessage.parts[0]?.state, error: "x".repeat(4_097) } }] }], "ses_primary", "printf main-ok"),
    ];

    // When each deviation crosses the parser.
    // Then none can be reported as a fail-closed execution receipt.
    for (const call of calls) expect(call).toThrow("sdk_malformed");
  });
});
