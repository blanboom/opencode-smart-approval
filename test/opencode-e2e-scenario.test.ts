import { describe, expect, test } from "bun:test";
import { parseBaselineAssistant, parseBaselineMessages } from "../scripts/opencode-e2e/baseline";

const completed = {
  info: { role: "assistant", sessionID: "ses_primary" },
  parts: [
    {
      type: "tool",
      tool: "bash",
      state: { status: "completed", input: { command: "printf main-ok" }, output: "main-ok" },
    },
    { type: "text", text: "main-ok" },
  ],
};

describe("baseline inference result", () => {
  test("accepts one completed byte-exact bash call and final text", () => {
    // Given a flattened prompt envelope for the exact primary session.
    // When the baseline boundary parses its assistant message.
    const final = parseBaselineAssistant({ ...completed, parts: completed.parts.slice(1) }, "ses_primary");
    const tool = parseBaselineMessages([completed], "ses_primary");

    // Then exact command, tool output, and final text are retained.
    expect({ ...tool, ...final }).toEqual({ command: "printf main-ok", output: "main-ok", text: "main-ok" });
  });

  test("rejects wrong sessions, missing tools, altered commands, and failed tools", () => {
    // Given every security-relevant deviation from the baseline assistant grammar.
    const calls = [
      () => parseBaselineAssistant(completed, "ses_other"),
      () => parseBaselineAssistant({ ...completed, parts: [] }, "ses_primary"),
      () => parseBaselineMessages([{ ...completed, parts: [{ ...completed.parts[0], state: { ...completed.parts[0]?.state, input: { command: "printf changed" } } }] }], "ses_primary"),
      () => parseBaselineMessages([{ ...completed, parts: [{ ...completed.parts[0], state: { status: "error", input: { command: "printf main-ok" }, error: "blocked" } }] }], "ses_primary"),
    ];

    // When each envelope crosses the parser.
    // Then every deviation fails closed without accepting partial success.
    for (const call of calls) expect(call).toThrow("sdk_malformed");
  });
});
