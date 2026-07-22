import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { findConfigWrite } from "../src/config-self-protection";
import { createHook } from "../src/index";
import { canonicalPath } from "../src/path-boundary";
import { analyzeShell } from "../src/shell-analysis";

type Fixture = {
  readonly configDirectory: string;
  readonly directory: string;
  readonly policyPath: string;
  readonly cleanup: () => void;
};

const fixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "approval-self-protection-cwd-"));
  const directory = join(root, "project");
  const configDirectory = join(root, "xdg", "opencode");
  mkdirSync(directory, { recursive: true });
  mkdirSync(configDirectory, { recursive: true });
  const policyPath = join(configDirectory, "command-approval.jsonc");
  writeFileSync(policyPath, JSON.stringify({
    version: 3,
    self_protection: { enabled: true },
    review: {},
    tirith: { enabled: false, fail_open: true },
    rules: { allow: [{ match: ".*", scope: "segment", priority: 100 }] },
  }));
  return {
    configDirectory,
    directory,
    policyPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

const createFixtureHook = (current: Fixture): ReturnType<typeof createHook> => {
  const previousXdg = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = join(current.configDirectory, "..");
  const hook = createHook(current.directory);
  if (previousXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = previousXdg;
  return hook;
};

describe("config self-protection cwd and git operation boundaries", () => {
  test("does not resolve a relative mutation against a fabricated cwd after cd dash", async () => {
    const current = fixture();
    try {
      const command = `OLDPWD=${current.configDirectory} cd - && touch command-approval.jsonc`;
      const analysis = await analyzeShell(command, current.directory);
      const finding = findConfigWrite({
        tool: "bash",
        args: { command },
        directory: current.directory,
        policyPaths: [current.policyPath],
        analysis,
      });
      expect(finding).toMatchObject({ action: "force_review" });

      const hook = createFixtureHook(current);
      await expect(hook(
        { tool: "bash", sessionID: "unknown-cwd", callID: "unknown-cwd-call" },
        { args: { command } },
      )).rejects.toMatchObject({
        verdict: { categories: [{ id: "security.reviewer_unavailable", score: 1 }] },
      });
    } finally {
      current.cleanup();
    }
  });

  test.each(["--get", "--get-all", "--get-regexp", "--list"])(
    "treats git config %s against an active policy as proven read-only",
    async (operation) => {
      const current = fixture();
      try {
        const suffix = operation === "--list" ? "" : " core.editor";
        const command = `git config --file ${current.policyPath} ${operation}${suffix}`;
        const finding = findConfigWrite({
          tool: "bash",
          args: { command },
          directory: current.directory,
          policyPaths: [current.policyPath],
          analysis: await analyzeShell(command, current.directory),
        });
        expect(finding).toEqual({ action: "none" });
        await expect(Promise.resolve(createFixtureHook(current)(
          { tool: "bash", sessionID: "git-read", callID: `git-read-${operation}` },
          { args: { command } },
        ))).resolves.toBeUndefined();
      } finally {
        current.cleanup();
      }
    },
  );

  test.each([
    "core.editor", "--show-origin --get core.editor", "--type bool --get core.filemode", "--default vim --get core.editor",
    "--bool-or-str --get core.editor", "-t bool --get core.filemode", "--no-default --get core.editor", "-ztbool --list",
  ])("treats git config %s as a proven read", async (argumentsText) => {
    const current = fixture();
    try {
      const command = `git config --file ${current.policyPath} ${argumentsText}`;
      expect(findConfigWrite({
        tool: "bash",
        args: { command },
        directory: current.directory,
        policyPaths: [current.policyPath],
        analysis: await analyzeShell(command, current.directory),
      })).toEqual({ action: "none" });
      await expect(Promise.resolve(createFixtureHook(current)(
        { tool: "bash", sessionID: "legacy-read", callID: "legacy-read-call" }, { args: { command } },
      ))).resolves.toBeUndefined();
    } finally {
      current.cleanup();
    }
  });

  test.each(["--add core.editor vim", "--unset core.editor", "--edit", "--bool-or-str --add core.editor true", "-t bool --add core.editor true", "-tbool --add core.editor true"])(
    "still blocks the explicit git config mutation %s",
    async (argumentsText) => {
      const current = fixture();
      try {
        const command = `git config --file ${current.policyPath} ${argumentsText}`;
        expect(findConfigWrite({
          tool: "bash",
          args: { command },
          directory: current.directory,
          policyPaths: [current.policyPath],
          analysis: await analyzeShell(command, current.directory),
        })).toMatchObject({ action: "block", path: canonicalPath(current.policyPath) });
      } finally {
        current.cleanup();
      }
    },
  );

  test("routes an unknown git config operation to review instead of claiming a write", async () => {
    const current = fixture();
    try {
      const command = `git config --file ${current.policyPath} --future-option core.editor`;
      expect(findConfigWrite({
        tool: "bash",
        args: { command },
        directory: current.directory,
        policyPaths: [current.policyPath],
        analysis: await analyzeShell(command, current.directory),
      })).toMatchObject({ action: "force_review" });
    } finally {
      current.cleanup();
    }
  });

  test.each([
    "get --file POLICY core.editor", "get --file - POLICY", "--file - --get POLICY",
    "get --file POLICY --all core.editor",
    "get --file POLICY --regexp '^core\\.'",
    "get --file POLICY --value=vim core.editor",
    "get --file POLICY --url=https://example.invalid core.editor",
    "list --file POLICY",
    "list --type=bool --file POLICY", "list -ztbool --file POLICY", "list -zfPOLICY",
    "list --type bool --file POLICY",
    "list -t bool --file POLICY",
    "list --bool --show-names --file POLICY",
    "list --no-type --file POLICY",
    "get --no-default --file POLICY core.editor", "get --file POLICY --default= missing.key", "get --file POLICY --default \"\" missing.key", "--file POLICY --default= --get missing.key", "--file POLICY --default \"\" --get missing.key",
  ])("allows the modern proven read: git config %s", async (template) => {
    const current = fixture();
    try {
      const command = `git config ${template.replace("POLICY", current.policyPath)}`;
      expect(findConfigWrite({
        tool: "bash",
        args: { command },
        directory: current.directory,
        policyPaths: [current.policyPath],
        analysis: await analyzeShell(command, current.directory),
      })).toEqual({ action: "none" });
      await expect(Promise.resolve(createFixtureHook(current)(
        { tool: "bash", sessionID: "modern-read", callID: "modern-read-call" },
        { args: { command } },
      ))).resolves.toBeUndefined();
    } finally {
      current.cleanup();
    }
  });

  test.each([
    "edit --file POLICY", "-efPOLICY",
    "set --file POLICY core.editor vim", "set -tbool -fPOLICY core.editor true",
    "set --file POLICY --bool core.editor true",
    "set --file POLICY --comment message core.editor vim",
    "set --file POLICY --append core.editor vim",
    "unset --file POLICY core.editor",
    "unset --file POLICY --no-all core.editor",
    "rename-section --file POLICY old new",
    "remove-section --file POLICY core",
  ])("blocks the modern mutation: git config %s", async (template) => {
    const current = fixture();
    try {
      const command = `git config ${template.replace("POLICY", current.policyPath)}`;
      expect(findConfigWrite({
        tool: "bash",
        args: { command },
        directory: current.directory,
        policyPaths: [current.policyPath],
        analysis: await analyzeShell(command, current.directory),
      })).toMatchObject({ action: "block", path: canonicalPath(current.policyPath) });
      await expect(createFixtureHook(current)(
        { tool: "bash", sessionID: "modern-write", callID: "modern-write-call" },
        { args: { command } },
      )).rejects.toMatchObject({
        verdict: { categories: [{ id: "security.config_self_protection", score: 1 }] },
      });
    } finally {
      current.cleanup();
    }
  });

  test.each([
    "future-op --file POLICY", "future-op POLICY", "get --file POLICY --future-option core.editor",
    "get --file POLICY --type --future-option core.editor", "get --file POLICY --type= core.editor", "get --type \"\" --file POLICY core.editor",
    "edit --future-file POLICY", "set --future-file POLICY core.demo true", "edit --file --future-option POLICY",
    "edit --includes POLICY", "set --includes POLICY core.demo true", "--future-option POLICY --list",
    "--future-file POLICY --edit", "--file --future-option POLICY --edit",
    "--append POLICY --edit", "--format POLICY --edit", "--value POLICY --edit", "--all --file POLICY --list", "edit POLICY", "--comment POLICY --edit", "--default POLICY --list",
  ])("forces review for the unknown modern form: git config %s", async (template) => {
    const current = fixture();
    try {
      const command = `git config ${template.replace("POLICY", current.policyPath)}`;
      expect(findConfigWrite({
        tool: "bash",
        args: { command },
        directory: current.directory,
        policyPaths: [current.policyPath],
        analysis: await analyzeShell(command, current.directory),
      })).toMatchObject({ action: "force_review" });
      await expect(createFixtureHook(current)(
        { tool: "bash", sessionID: "modern-unknown", callID: "modern-unknown-call" },
        { args: { command } },
      )).rejects.toMatchObject({
        verdict: { categories: [{ id: "security.reviewer_unavailable", score: 1 }] },
      });
    } finally {
      current.cleanup();
    }
  });
});
