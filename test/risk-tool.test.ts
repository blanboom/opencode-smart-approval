import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPolicy } from "../src/default-config";
import {
  evaluationWithTirithScan,
  scanFromTirithResult,
  scanWithTirith,
  verdictFromTirithScan,
} from "../src/risk-tool";
import { runTirithCompatibleTool } from "../src/risk-tool-runner";
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
});

const writeExecutable = (directory: string, body: string): string => {
  const path = join(directory, "risk-tool-fake");
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
};

const policyWithTirith = (
  directory: string,
  overrides: Partial<ResolvedPolicy["tirith"]> = {},
): ResolvedPolicy => ({
  ...defaultPolicy(),
  tirith: {
    enabled: true,
    timeoutMs: 5_000,
    failOpen: false,
    path: join(directory, "risk-tool-fake"),
    ...overrides,
  },
});

describe("Tirith scanning", () => {
  test("blocks before command execution when the Tirith returns block", async () => {
    const directory = tempDir();
    const path = writeExecutable(
      directory,
      `#!/bin/sh
printf '%s\\n' '{"summary":"blocked by fake","findings":[{"rule_id":"pipe_to_interpreter","severity":"HIGH","title":"Pipe to shell","description":"download executes"}]}'
exit 1
`,
    );
    const scan = await scanWithTirith(policyWithTirith(directory, { path }), commandContext(directory, "echo hello"));
    const verdict = verdictFromTirithScan(scan);
    expect(scan.action).toBe("block");
    expect(verdict?.source).toBe("risk_tool");
    expect(verdict?.reasons.join("; ")).toContain("Pipe to shell");
  });

  test("attaches Tirith warnings to the final OpenCode reviewer evaluation", async () => {
    const directory = tempDir();
    const path = writeExecutable(
      directory,
      `#!/bin/sh
printf '%s\\n' '{"summary":"warning by fake","findings":[{"rule_id":"lookalike_tld","severity":"MEDIUM","title":"Lookalike host"}]}'
exit 2
`,
    );
    const scan = await scanWithTirith(policyWithTirith(directory, { path }), commandContext(directory, "echo hello"));
    if (scan.action !== "warn") throw new Error("expected warning scan result");
    const evaluation = await evaluateRules([], { command: "unknown-command" });
    const merged = evaluationWithTirithScan(evaluation, scan);
    expect(evaluation.decision).toBe("review");
    expect(merged.decision).toBe("review");
    expect(merged.reasons.join("; ")).toContain("warning by fake");
  });

  test("Tirith operational failures fail closed by default", async () => {
    const directory = tempDir();
    const scan = await scanWithTirith(
      policyWithTirith(directory, { path: join(directory, "missing-risk-tool") }),
      commandContext(directory, "echo hello"),
    );
    const verdict = verdictFromTirithScan(scan);
    expect(scan.action).toBe("block");
    expect(verdict?.source).toBe("fail_closed");
    expect(verdict?.reasons).toEqual(["risk_tool_failure:start"]);
  });

  test("rejects a relative configured executable before using the command cwd", async () => {
    // Given a relative Tirith path and a matching executable under the command cwd.
    const directory = tempDir();
    writeExecutable(
      directory,
      `#!/bin/sh
printf '%s\\n' '{"summary":"attacker executable ran"}'
exit 0
`,
    );

    // When the configured executable is run.
    const result = await runTirithCompatibleTool(
      policyWithTirith(directory, { path: "./risk-tool-fake" }),
      commandContext(directory, "echo hello"),
    );

    // Then the runner rejects the path instead of resolving it against the project cwd.
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected relative path rejection");
    expect(result.error.message).toContain("absolute");
  });

  test("treats an unavailable auto-install target according to fail_open", () => {
    const directory = tempDir();
    const skipped = { kind: "skipped", reason: "unsupported platform test/arch" } as const;
    const closed = scanFromTirithResult(policyWithTirith(directory), skipped);
    const opened = scanFromTirithResult(policyWithTirith(directory, { failOpen: true }), skipped);
    expect(closed.action).toBe("block");
    expect(closed.action === "block" ? closed.source : undefined).toBe("fail_closed");
    expect(opened.action).toBe("allow");
  });

  test("propagates stale-verified binary freshness into reviewer evidence", async () => {
    // Given an allowed Tirith process run from a locally reverified stale cache.
    const directory = tempDir();
    const scan = scanFromTirithResult(policyWithTirith(directory), {
      kind: "exit",
      exitCode: 0,
      signal: null,
      stdout: "{}",
      stderr: "",
      freshness: "stale_verified",
    });
    const evaluation = await evaluateRules([], { command: "unknown-command" });

    // When scanner evidence is merged for review.
    const merged = evaluationWithTirithScan(evaluation, scan);

    // Then both the typed scan state and fixed reviewer evidence disclose degradation.
    expect(scan.freshness).toBe("stale_verified");
    expect(merged.categories).toContainEqual({ id: "risk_tool.stale_verified", score: 0.5 });
    expect(merged.reasons).toContain("Tirith cached binary is stale but locally hash verified");
  });
});
