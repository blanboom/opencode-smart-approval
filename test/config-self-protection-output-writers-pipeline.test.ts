import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createHook } from "../src/index";

type HookFixture = {
  readonly hook: ReturnType<typeof createHook>;
  readonly cleanup: () => void;
};

const hookFixture = (): HookFixture => {
  const root = mkdtempSync(join(tmpdir(), "approval-output-writers-"));
  const directory = join(root, "project");
  const configDirectory = join(root, "xdg", "opencode");
  mkdirSync(directory, { recursive: true });
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(join(configDirectory, "command-approval.jsonc"), JSON.stringify({
    version: 3,
    allow_local_config: true,
    self_protection: { enabled: true },
    review: {},
    tirith: { enabled: false, fail_open: true },
    rules: { allow: [{ match: ".*", scope: "segment", priority: 100 }] },
  }));
  const previousXdg = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = join(root, "xdg");
  const hook = createHook(directory);
  if (previousXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = previousXdg;
  return { hook, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

describe("config self-protection output-writer ordering", () => {
  test.each([
    "find . -fprint command-approval.jsonc",
    "rsync --log-file=command-approval.jsonc /tmp/source /tmp/destination",
    "git archive --output=command-approval.jsonc HEAD",
    "git bundle create command-approval.jsonc --all",
    "/usr/bin/time -o command-approval.jsonc cat /tmp/input",
  ])("blocks %s before an allow-all terminal rule", async (command) => {
    // Given enabled self-protection and a user rule that otherwise allows every segment.
    const fixture = hookFixture();
    try {
      // When an implicit command output targets the active project policy.
      const action = fixture.hook(
        { tool: "bash", sessionID: "output-writer", callID: "output-writer-call" },
        { args: { command } },
      );

      // Then self-protection blocks before the terminal allow can return.
      await expect(action).rejects.toMatchObject({
        verdict: { categories: [{ id: "security.config_self_protection", score: 1 }] },
      });
    } finally {
      fixture.cleanup();
    }
  });
});
