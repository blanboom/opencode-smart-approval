import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createHook } from "../src/index";

type ConfiguredHook = {
  readonly hook: ReturnType<typeof createHook>;
  readonly globalPolicyPath: string;
  readonly localPolicyPath: string;
  readonly cleanup: () => void;
};

const configuredHook = (enabled: boolean): ConfiguredHook => {
  const root = mkdtempSync(join(tmpdir(), "approval-self-protection-"));
  const xdg = join(root, "xdg");
  const directory = join(root, "project");
  const globalDirectory = join(xdg, "opencode");
  const globalPolicyPath = join(globalDirectory, "command-approval.jsonc");
  const localPolicyPath = join(directory, "command-approval.jsonc");
  mkdirSync(globalDirectory, { recursive: true });
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(directory, "subdir"));
  mkdirSync(join(directory, "-foo"));
  writeFileSync(globalPolicyPath, JSON.stringify({
    version: 2,
    self_protection: { enabled },
    review: {
      base_url: "http://127.0.0.1:1/v1",
      api_key: "test-key",
      model: "test-model",
      max_retries: 0,
    },
    tirith: { enabled: false, fail_open: true },
    rules: {
      allow: [{ match: ".*", scope: "segment", priority: 100 }],
      block: [],
      review: [],
    },
  }));

  const previousXdg = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = xdg;
  const hook = createHook(directory);
  if (previousXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = previousXdg;

  return {
    hook,
    globalPolicyPath,
    localPolicyPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

const invoke = (
  hook: ReturnType<typeof createHook>,
  tool: string,
  args: Record<string, unknown>,
): Promise<void> => hook(
  { tool, sessionID: "self-protection", callID: `${tool}-call` },
  { args },
);

describe("approval configuration self-protection", () => {
  test.each([
    ["write", (path: string) => ({ filePath: path, content: "{}" })],
    ["edit", (path: string) => ({ filePath: path, oldString: "{}", newString: "{\"changed\":true}" })],
  ] as const)("blocks OpenCode %s writes to the active global policy by default", async (tool, argsFor) => {
    // Given a policy whose self-protection is enabled.
    const fixture = configuredHook(true);
    try {
      // When the OpenCode file tool targets the policy itself.
      const action = invoke(fixture.hook, tool, argsFor(fixture.globalPolicyPath));

      // Then the plugin rejects the write before the tool executes.
      await expect(action).rejects.toMatchObject({
        verdict: { categories: [{ id: "security.config_self_protection", score: 1 }] },
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("blocks apply_patch when any hunk targets a project policy", async () => {
    // Given an enabled policy and a patch that includes its project-local counterpart.
    const fixture = configuredHook(true);
    try {
      const patchText = [
        "*** Begin Patch",
        "*** Update File: command-approval.jsonc",
        "@@",
        "-{}",
        "+{\"changed\":true}",
        "*** End Patch",
      ].join("\n");

      // When apply_patch is intercepted.
      const action = invoke(fixture.hook, "apply_patch", { patchText });

      // Then the complete patch is rejected.
      await expect(action).rejects.toMatchObject({
        verdict: { categories: [{ id: "security.config_self_protection", score: 1 }] },
      });
    } finally {
      fixture.cleanup();
    }
  });

  test.each([
    "printf '{}' > command-approval.jsonc",
    "bash -c \"printf '{}' > command-approval.jsonc\"",
    "env bash -c \"printf '{}' > command-approval.jsonc\"",
    "nice sh -c \"printf '{}' > command-approval.jsonc\"",
    "printf '{}' | tee command-approval.jsonc",
    "printf '{}' | sudo tee command-approval.jsonc",
    "node -e \"require('fs').writeFileSync('command-approval.jsonc', '{}')\"",
    "cd subdir && printf '{}' > ../command-approval.jsonc",
    "cd -- -foo && printf '{}' > ../command-approval.jsonc",
    "cp /tmp/command-approval.jsonc .",
    "cp -t . /tmp/command-approval.jsonc",
    "cp /tmp/payload command-approval.jsonc -S .bak",
    "cp /tmp/payload command-approval.jsonc --suffix .bak",
    "install --target-directory=. /tmp/command-approval.jsonc",
    "install /tmp/payload command-approval.jsonc -m 600",
    "install /tmp/payload command-approval.jsonc --mode 600",
    "rsync /tmp/command-approval.jsonc .",
    "rsync -t /tmp/payload command-approval.jsonc",
    "rsync /tmp/payload command-approval.jsonc --exclude ignored",
    "rsync /tmp/payload command-approval.jsonc --stop-after 5",
    "rsync /tmp/payload command-approval.jsonc --skip-compress gz",
    "rsync /tmp/payload command-approval.jsonc --outbuf L",
    "rsync /tmp/payload command-approval.jsonc --chown nobody:nogroup",
    "rsync /tmp/payload command-approval.jsonc --early-input seed",
    "target=command-approval.jsonc; printf '{}' > \"$target\"",
    "name=command-approval; printf '{}' > \"$name.jsonc\"",
  ])("blocks a static Bash policy write: %s", async (command) => {
    // Given enabled self-protection.
    const fixture = configuredHook(true);
    try {
      // When Bash directly or indirectly writes the policy.
      const action = invoke(fixture.hook, "bash", { command });

      // Then the write is rejected.
      await expect(action).rejects.toMatchObject({
        verdict: { categories: [{ id: "security.config_self_protection", score: 1 }] },
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("allows the same config write to continue when self-protection is disabled", async () => {
    // Given a trusted policy that explicitly disables self-protection.
    const fixture = configuredHook(false);
    try {
      // When a user-allowed Bash command writes the local policy.
      const action = invoke(fixture.hook, "bash", { command: "printf '{}' > command-approval.jsonc" });

      // Then the ordinary approval pipeline allows it.
      await expect(action).resolves.toBeUndefined();
    } finally {
      fixture.cleanup();
    }
  });

  test("does not block an adjacent non-policy file", async () => {
    // Given enabled self-protection and a similarly named ordinary file.
    const fixture = configuredHook(true);
    try {
      // When Write targets the adjacent file.
      const action = invoke(fixture.hook, "write", {
        filePath: `${fixture.localPolicyPath}.backup`,
        content: "backup",
      });

      // Then self-protection does not claim the operation.
      await expect(action).resolves.toBeUndefined();
    } finally {
      fixture.cleanup();
    }
  });

  test("allows rsync to read a policy as a source when a trailing option has a value", async () => {
    const fixture = configuredHook(true);
    try {
      const action = invoke(fixture.hook, "bash", {
        command: "rsync command-approval.jsonc /tmp/policy-backup --exclude ignored",
      });

      await expect(action).resolves.toBeUndefined();
    } finally {
      fixture.cleanup();
    }
  });
});
