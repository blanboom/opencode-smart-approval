import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPolicy } from "../src/default-config";
import { evaluationWithRiskToolScan, scanWithRiskTool, verdictFromRiskToolScan } from "../src/risk-tool";
import { evaluateRules } from "../src/rules";
import type { CommandContext, ResolvedPolicy } from "../src/types";

const tempDir = (): string => {
  return mkdtempSync(join(tmpdir(), "command-approval-test-"));
};

const commandContext = (directory: string, command: string): CommandContext => ({
  sessionID: "session-1",
  tool: "bash",
  command,
  cwd: directory,
  args: { command },
  scriptEvidence: [],
});

const writeExecutable = (directory: string, body: string): string => {
  const path = join(directory, "risk-tool-fake");
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
};

const policyWithRiskTool = (
  directory: string,
  overrides: Partial<ResolvedPolicy["riskTool"]> = {},
): ResolvedPolicy => ({
  ...defaultPolicy(),
  riskTool: {
    enabled: true,
    timeoutMs: 5_000,
    failOpen: false,
    path: join(directory, "risk-tool-fake"),
    ...overrides,
  },
});

describe("risk tool scanning", () => {
  test("blocks before command execution when the risk tool returns block", async () => {
    const directory = tempDir();
    const path = writeExecutable(
      directory,
      `#!/bin/sh
printf '%s\\n' '{"summary":"blocked by fake","findings":[{"rule_id":"pipe_to_interpreter","severity":"HIGH","title":"Pipe to shell","description":"download executes"}]}'
exit 1
`,
    );
    const scan = await scanWithRiskTool(policyWithRiskTool(directory, { path }), commandContext(directory, "echo hello"));
    const verdict = verdictFromRiskToolScan(scan);
    expect(scan.action).toBe("block");
    expect(verdict?.source).toBe("risk_tool");
    expect(verdict?.reasons.join("; ")).toContain("Pipe to shell");
  });

  test("risk tool warnings force LLM review even for allow-rule commands", async () => {
    const directory = tempDir();
    const path = writeExecutable(
      directory,
      `#!/bin/sh
printf '%s\\n' '{"summary":"warning by fake","findings":[{"rule_id":"lookalike_tld","severity":"MEDIUM","title":"Lookalike host"}]}'
exit 2
`,
    );
    const scan = await scanWithRiskTool(policyWithRiskTool(directory, { path }), commandContext(directory, "echo hello"));
    if (scan.action !== "warn") throw new Error("expected warning scan result");
    const evaluation = evaluateRules(defaultPolicy().rules, { command: "echo hello" });
    const merged = evaluationWithRiskToolScan(evaluation, scan);
    expect(evaluation.decision).toBe("allow");
    expect(merged.decision).toBe("review");
    expect(merged.reasons.join("; ")).toContain("warning by fake");
  });

  test("risk tool operational failures fail closed by default", async () => {
    const directory = tempDir();
    const scan = await scanWithRiskTool(
      policyWithRiskTool(directory, { path: join(directory, "missing-risk-tool") }),
      commandContext(directory, "echo hello"),
    );
    const verdict = verdictFromRiskToolScan(scan);
    expect(scan.action).toBe("block");
    expect(verdict?.source).toBe("fail_closed");
    expect(verdict?.reasons.join("; ")).toContain("risk tool failed to start");
  });
});
