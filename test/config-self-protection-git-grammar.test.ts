import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { findConfigWrite } from "../src/config-self-protection";
import { createHook } from "../src/index";
import { analyzeShell } from "../src/shell-analysis";

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "approval-git-grammar-"));
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
  return { configDirectory, directory, policyPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

const hookFor = (current: ReturnType<typeof fixture>): ReturnType<typeof createHook> => {
  const previous = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = join(current.configDirectory, "..");
  const hook = createHook(current.directory);
  if (previous === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = previous;
  return hook;
};

const commandFor = (template: string, policyPath: string): string =>
  `git config ${template.replaceAll("ACTIVE", policyPath)}`;

describe("Git 2.54 config grammar self-protection", () => {
  test.each([
    "set --file ACTIVE --comment - core.x y", "set --file ACTIVE --comment --future core.x y",
    "set --file ACTIVE --value - core.x y", "unset --file ACTIVE --value --future core.x",
    "--file ACTIVE --comment --future --add core.x y", "--file ACTIVE -z --edit",
    "--file ACTIVE --show-scope --edit", "--file ACTIVE --show-names --add core.x y",
    "--file ACTIVE --no-comment --edit", "--file ACTIVE --no-default --edit",
    "--file ACTIVE --no-fixed-value --edit", "--file ACTIVE --null --edit",
    "--file ACTIVE --no-name-only --edit", "--file ACTIVE --no-show-origin --edit",
    "-zefACTIVE", "edit --fi ACTIVE", "remove-section --fi ACTIVE core",
    "set --file ACTIVE --comm note core.x y", "set --file ACTIVE --app core.x y",
    "--file ACTIVE --edi", "--file ACTIVE --remove-s core",
    "--file ACTIVE --replace-a core.x y", "--file ACTIVE --unset-a core.x",
    "set --file ACTIVE --no-append --value pattern core.x y",
    "set --file ACTIVE --fixed-value --no-fixed-value core.x y",
    "--file ACTIVE --fixed-value --no-fixed-value --add core.x y",
    "--file ACTIVE --comment note --no-comment --edit",
    "--file ACTIVE --name-only --no-name-only --edit",
    "--file ACTIVE --show-origin --no-show-origin --edit",
    "--file ACTIVE --default x --no-default --edit",
    "edit --file /dev/null --file ACTIVE",
    "--file ACTIVE --edit --edit", "--file ACTIVE -e --edit", "--file ACTIVE -ee",
    "--file ACTIVE --add --add core.x y", "--file ACTIVE --replace-all --replace-all core.x y",
    "--file ACTIVE --unset --unset core.x", "--file ACTIVE --unset-all --unset-all core.x",
    "--file ACTIVE --rename-section --rename-section core next",
    "--file ACTIVE --remove-section --remove-section core",
    "set --file ACTIVE --bool --no-type --int core.x 1",
    "set --file ACTIVE --bool --bool core.x true", "set --file ACTIVE --type bool --bool core.x true",
  ])("exact-blocks valid writer spelling: git config %s", async (template) => {
    const current = fixture();
    try {
      const command = commandFor(template, current.policyPath);
      expect(findConfigWrite({
        tool: "bash", args: { command }, directory: current.directory,
        policyPaths: [current.policyPath], analysis: await analyzeShell(command, current.directory),
      })).toMatchObject({ action: "block" });
      await expect(hookFor(current)(
        { tool: "bash", sessionID: "git-grammar-write", callID: "git-grammar-write-call" }, { args: { command } },
      )).rejects.toMatchObject({ verdict: { categories: [{ id: "security.config_self_protection", score: 1 }] } });
    } finally {
      current.cleanup();
    }
  });

  test.each([
    "--file ACTIVE -z --get-urlmatch http.sslVerify https://example.invalid",
    "--file ACTIVE --show-scope --get-urlmatch http.sslVerify https://example.invalid",
    "--file ACTIVE --show-names --get-urlmatch http.sslVerify https://example.invalid",
    "--file ACTIVE --type bool --get-urlmatch http.sslVerify https://example.invalid",
    "--file ACTIVE -z --get-color color.ui", "--file ACTIVE --show-scope --get-color color.ui",
    "--file ACTIVE --name-only --list", "--file ACTIVE --name-only --get-regexp '^core\\.'",
    "--file ACTIVE --show-origin --no-show-origin --get-urlmatch http.sslVerify https://example.invalid",
    "--global --no-global --local --get ACTIVE",
    "--file ACTIVE --list --list", "--file ACTIVE -l --list", "--file ACTIVE -ll",
    "--file ACTIVE --no-type --get-color color.ui", "--file ACTIVE --bool --no-type --get-color color.ui",
    "--file ACTIVE -t bool --no-type --get-color color.ui", "--file ACTIVE --type bool --no-ty --get-colorbool color.ui",
    "list --file ACTIVE --bool --no-type --int", "list --file ACTIVE --bool --bool", "list --file ACTIVE --type bool --bool",
  ])("allows a proven legacy read: git config %s", async (template) => {
    const current = fixture();
    try {
      const command = commandFor(template, current.policyPath);
      expect(findConfigWrite({
        tool: "bash", args: { command }, directory: current.directory,
        policyPaths: [current.policyPath], analysis: await analyzeShell(command, current.directory),
      })).toEqual({ action: "none" });
      await expect(Promise.resolve(hookFor(current)(
        { tool: "bash", sessionID: "git-grammar-read", callID: "git-grammar-read-call" }, { args: { command } },
      ))).resolves.toBeUndefined();
    } finally {
      current.cleanup();
    }
  });

  test.each([
    "--file ACTIVE --fixed-value --list", "get --file ACTIVE --fixed-value core.x",
    "--file /dev/null --fixed-value --add ACTIVE y", "get --file ACTIVE --default x --all core.x",
    "get --file ACTIVE --url https://x --all core.x", "get --file ACTIVE --url https://x --regexp core.x",
    "get --file ACTIVE --url https://x --value pattern core.x",
    "set --file ACTIVE --append --value pattern core.x y",
    "--file ACTIVE --name-only --get core.x", "--file ACTIVE --name-only --get-all core.x",
    "set --file ACTIVE --no-append --append --value pattern core.x y",
    "set --file ACTIVE --no-fixed-value --fixed-value core.x y",
    "--file ACTIVE --no-comment --comment note --edit",
    "--file ACTIVE --no-name-only --name-only --edit",
    "--file ACTIVE --no-show-origin --show-origin --edit",
    "--file ACTIVE --no-default --default x --edit",
    "get --file ACTIVE --value pattern --no-value --fixed-value core.x",
    "get --file ACTIVE --global core.x", "set --file /dev/null --global ACTIVE y",
    "list --file ACTIVE --blob deadbeef", "--file ACTIVE --show-origin --get-urlmatch http.sslVerify https://example.invalid",
    "--file ACTIVE --show-origin --get-color color.ui",
    "--file ACTIVE --no-type --bool --get-color color.ui",
    "list --file ACTIVE --bool --int --no-type", "--file ACTIVE --bool --int --no-type --get core.x",
    "--file ACTIVE --bool --int --no-type --get-color color.ui",
    "set --file ACTIVE --bool --int --no-type core.x 1", "--file ACTIVE --bool --int --no-type --edit",
    "list --file ACTIVE --type future", "list --file ACTIVE -tfuture", "set --file ACTIVE --type future core.x value",
  ])("forces review for invalid option dependencies: git config %s", async (template) => {
    const current = fixture();
    try {
      const command = commandFor(template, current.policyPath);
      expect(findConfigWrite({
        tool: "bash", args: { command }, directory: current.directory,
        policyPaths: [current.policyPath], analysis: await analyzeShell(command, current.directory),
      })).toMatchObject({ action: "force_review" });
      await expect(hookFor(current)(
        { tool: "bash", sessionID: "git-grammar-invalid", callID: "git-grammar-invalid-call" }, { args: { command } },
      )).rejects.toMatchObject({ verdict: { categories: [{ id: "security.reviewer_unavailable", score: 1 }] } });
    } finally {
      current.cleanup();
    }
  });

  test.each([
    "edit --file ACTIVE --no-file", "edit --file ACTIVE --file /dev/null", "edit --fi ACTIVE --no-fi",
  ])("does not block a superseded active file target: git config %s", async (template) => {
    const current = fixture();
    try {
      const command = commandFor(template, current.policyPath);
      expect(findConfigWrite({
        tool: "bash", args: { command }, directory: current.directory,
        policyPaths: [current.policyPath], analysis: await analyzeShell(command, current.directory),
      })).toEqual({ action: "none" });
      await expect(Promise.resolve(hookFor(current)(
        { tool: "bash", sessionID: "git-source-state", callID: "git-source-state-call" }, { args: { command } },
      ))).resolves.toBeUndefined();
    } finally {
      current.cleanup();
    }
  });
});
