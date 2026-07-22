import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createHook } from "../src/index";

type ConfiguredHook = {
  readonly hook: ReturnType<typeof createHook>;
  readonly globalPolicyPath: string;
  readonly localPolicyPath: string;
  readonly legacyLocalPolicyPath: string;
  readonly cleanup: () => void;
};

const configuredHook = (enabled: boolean, allowLocalConfig = true): ConfiguredHook => {
  const root = mkdtempSync(join(tmpdir(), "approval-self-protection-"));
  const xdg = join(root, "xdg");
  const directory = join(root, "project");
  const globalDirectory = join(xdg, "opencode");
  const globalPolicyPath = join(globalDirectory, "command-approval.jsonc");
  const localPolicyPath = join(directory, "command-approval.jsonc");
  const legacyLocalPolicyPath = join(directory, "command-approval.json");
  mkdirSync(globalDirectory, { recursive: true });
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(directory, "subdir"));
  mkdirSync(join(directory, "-foo"));
  writeFileSync(globalPolicyPath, JSON.stringify({
    version: 3,
    allow_local_config: allowLocalConfig,
    self_protection: { enabled },
    review: {},
    tirith: { enabled: false, fail_open: true },
    rules: {
      allow: [{ match: ".*", scope: "segment", priority: 100 }],
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
    legacyLocalPolicyPath,
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
    "printf '{}' | tee command-approval.jsonc",
    "printf '{}' | sudo tee command-approval.jsonc",
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

  test("does not protect inactive project or legacy policy paths", async () => {
    // Given trusted global policy does not opt into the project policy.
    const fixture = configuredHook(true, false);
    try {
      // When file tools target inactive project JSONC and legacy JSON names.
      const localWrite = invoke(fixture.hook, "write", { filePath: fixture.localPolicyPath, content: "{}" });
      const legacyWrite = invoke(fixture.hook, "write", { filePath: fixture.legacyLocalPolicyPath, content: "{}" });

      // Then both continue because neither path is reload-effective.
      await expect(localWrite).resolves.toBeUndefined();
      await expect(legacyWrite).resolves.toBeUndefined();
    } finally {
      fixture.cleanup();
    }
  });

  test("does not let a trusted allow shortcut bypass force_review", async () => {
    // Given allow-all user rules and an interpreter that can mutate the active project policy.
    const fixture = configuredHook(true);
    try {
      // When self-protection cannot prove the interpreter's exact effect.
      const action = invoke(fixture.hook, "bash", {
        command: "python -c \"open('command-' + 'approval.jsonc', 'w').write('{}')\"",
      });

      // Then the unavailable reviewer fails closed instead of the allow rule terminating the pipeline.
      await expect(action).rejects.toMatchObject({
        verdict: { categories: [{ id: "security.reviewer_unavailable", score: 1 }] },
      });
    } finally {
      fixture.cleanup();
    }
  });
});
