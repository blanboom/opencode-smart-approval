import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveInvocation, invocationFromSegment } from "../src/command-invocation";
import { evaluateExecutableGuard } from "../src/path-safety";
import { analyzeShell } from "../src/shell-analysis";
import { evaluate } from "./mandatory-guards-helpers";

describe("mandatory path and executable safety", () => {
  test("preserves attached quoted tilde spelling on indirect jq input", async () => {
    expect((await evaluate("jq --run-tests='~/.ssh/id_rsa'", true)).decision).toBe("review");
  });

  test("does not confuse an earlier pipeline with a later standalone shell", async () => {
    expect((await evaluate("echo ok | grep ok; sh script.sh")).decision).toBe("review");
  });

  test("reviews a local reader symlink that escapes the working directory", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "approval-reader-root-"));
    symlinkSync("/etc/hosts", join(cwd, "innocuous-link"));
    expect((await evaluate("cat innocuous-link", false, cwd)).decision).toBe("review");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("reviews a reader glob whose match is a symlink outside the working directory", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "approval-reader-glob-root-"));
    symlinkSync("/etc/hosts", join(cwd, "link-out"));
    expect((await evaluate("cat link-*", false, cwd)).decision).toBe("review");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("reviews relative, absolute, and tilde glob paths that traverse escaping symlinks", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "approval-reader-glob-symlink-"));
    symlinkSync("/etc", join(cwd, "link-out"));
    expect((await evaluate("cat link-*/hosts", false, cwd)).decision).toBe("review");
    expect((await evaluate(`cat ${cwd}/link-*/hosts`, false, cwd)).decision).toBe("review");
    expect((await evaluate("cat ~+/link-*/hosts", false, cwd)).decision).toBe("review");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("blocks redirection and reader globs whose match resolves to a sensitive file", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "approval-sensitive-glob-link-"));
    writeFileSync(join(cwd, ".env.production"), "placeholder\n");
    symlinkSync(".env.production", join(cwd, "result-sensitive"));
    expect((await evaluate(`cat ${cwd}/result-*`, false, cwd)).decision).toBe("block");
    expect((await evaluate(`echo hi > ${cwd}/result-*`, true, cwd)).decision).toBe("block");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("reviews output-redirection glob matches that escape a temporary directory", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "approval-output-glob-link-"));
    symlinkSync("/etc/hosts", join(cwd, "result-out"));
    expect((await evaluate(`echo hi > ${cwd}/result-*`, true, cwd)).decision).toBe("review");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("recognizes hidden and recursive search aliases", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "approval-search-aliases-"));
    writeFileSync(join(cwd, ".env.production"), "placeholder\n");
    for (const command of [
      "rg -. needle .",
      "rg -.i needle .",
      "rg --unrestricted --unrestricted needle .",
      "rg -u --unrestricted needle .",
      "grep -d recurse needle .",
      "grep -drecurse needle .",
      "grep --directories=recurse needle .",
      "rg -g '*.env' needle .",
      "cat {.env,README.md}",
    ]) {
      expect((await evaluate(command, false, cwd)).decision, command).toBe("block");
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  test("treats ripgrep directory operands as recursive by default", async () => {
    const sensitiveRoot = mkdtempSync(join(tmpdir(), "approval-rg-recursive-sensitive-"));
    mkdirSync(join(sensitiveRoot, "config"));
    writeFileSync(join(sensitiveRoot, "config", "auth.json"), "placeholder\n");
    expect((await evaluate("rg needle .", false, sensitiveRoot)).decision).toBe("block");
    expect((await evaluate("rg --files-with-matches needle .", false, sensitiveRoot)).decision).toBe("block");
    rmSync(sensitiveRoot, { recursive: true, force: true });

    const safeRoot = mkdtempSync(join(tmpdir(), "approval-rg-recursive-safe-"));
    mkdirSync(join(safeRoot, "src"));
    writeFileSync(join(safeRoot, "src", "main.ts"), "const value = 'needle';\n");
    expect((await evaluate("rg needle .", false, safeRoot)).decision).toBe("allow");
    rmSync(safeRoot, { recursive: true, force: true });
  });

  test("does not recursively scan nested directories for a flat glob", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "approval-flat-glob-"));
    for (let index = 0; index < 520; index += 1) {
      const directory = join(cwd, `entry-${String(index)}`);
      mkdirSync(directory);
      writeFileSync(join(directory, "nested.md"), "text\n");
    }
    writeFileSync(join(cwd, "top.md"), "text\n");
    expect((await evaluate("cat *.md", false, cwd)).decision).toBe("allow");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("resolves Git subcommand paths after sequential -C options", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "approval-git-cwd-"));
    mkdirSync(join(cwd, "repo"));
    writeFileSync(join(cwd, "message"), "message\n");
    expect((await evaluate("git -C repo commit -F ../message", true, cwd)).decision).toBe("allow");
    expect((await evaluate("git -C repo status --short ../message", false, cwd)).decision).toBe("allow");
    expect((await evaluate("git -C repo commit -F ../../../etc/passwd", true, cwd)).decision).toBe("review");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("reviews git status only when the repository config names an external fsmonitor helper", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "approval-git-fsmonitor-"));
    mkdirSync(join(cwd, ".git", "objects"), { recursive: true });
    mkdirSync(join(cwd, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(cwd, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n\tfsmonitor = /tmp/helper\n");
    expect((await evaluate("git status", false, cwd)).decision).toBe("review");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("reviews temporary-root environment values that escape through a symlink", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "approval-environment-symlink-"));
    symlinkSync("/etc", join(cwd, "temp-out"));
    expect((await evaluate(`TMPDIR=${join(cwd, "temp-out")} sort README.md`, true, cwd)).decision).toBe("review");
    expect((await evaluate(`HOME=${join(cwd, "temp-out")} xcodebuildmcp tools`, true, cwd)).decision).toBe("review");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("blocks a reader symlink whose canonical target is a credential file", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "approval-reader-sensitive-link-"));
    writeFileSync(join(cwd, ".env"), "not-a-secret\n");
    symlinkSync(".env", join(cwd, "safe.txt"));
    expect((await evaluate("cat safe.txt", false, cwd)).decision).toBe("block");
    expect((await evaluate("rg needle safe.*", false, cwd)).decision).toBe("block");
    expect((await evaluate("cat *", false, cwd)).decision).toBe("block");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("does not make a broad visible glob match a hidden credential by name alone", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "approval-reader-hidden-glob-"));
    writeFileSync(join(cwd, ".env"), "not-a-secret\n");
    expect((await evaluate("cat *", false, cwd)).decision).toBe("allow");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("canonicalizes nonexistent paths through the nearest existing parent", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "approval-reader-canonical-"));
    expect((await evaluate(`cat ${join(cwd, "nonexistent-safe")}`, false, cwd)).decision).toBe("allow");
    expect((await evaluate("cat '~\/ordinary.txt'", false, cwd)).decision).toBe("allow");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("bounds recursive glob traversal even when the pattern has no matches", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "approval-reader-bounded-glob-"));
    for (let index = 0; index < 520; index += 1) mkdirSync(join(cwd, `entry-${String(index)}`));
    expect((await evaluate("cat **/definitely-not-present", false, cwd)).decision).toBe("review");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("reviews a protected command that PATH resolves inside the working directory", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "approval-executable-root-"));
    const executable = join(cwd, "rg");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    const segment = (await analyzeShell("rg needle file")).segments[0];
    expect(segment).toBeDefined();
    const finding = segment
      ? evaluateExecutableGuard(effectiveInvocation(invocationFromSegment(segment)), cwd, cwd)
      : undefined;
    expect(finding?.decision).toBe("review");
    rmSync(cwd, { recursive: true, force: true });
  });

  test.each(["", ".", "bin"])("reviews protected commands resolved through a local PATH entry: %s", async (entry) => {
    const cwd = mkdtempSync(join(tmpdir(), "approval-relative-path-"));
    const directory = entry === "bin" ? join(cwd, entry) : cwd;
    if (entry === "bin") mkdirSync(directory);
    const executable = join(directory, "rg");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    const segment = (await analyzeShell("rg needle file")).segments[0];
    const finding = segment
      ? evaluateExecutableGuard(effectiveInvocation(invocationFromSegment(segment)), cwd, entry)
      : undefined;
    expect(finding?.decision).toBe("review");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("reviews an unresolved protected executable", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "approval-unresolved-executable-"));
    const segment = (await analyzeShell("./rg needle file")).segments[0];
    const finding = segment
      ? evaluateExecutableGuard(effectiveInvocation(invocationFromSegment(segment)), cwd, "/missing")
      : undefined;
    expect(finding?.decision).toBe("review");
    rmSync(cwd, { recursive: true, force: true });
  });
});
