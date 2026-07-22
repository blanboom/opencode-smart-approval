import { describe, expect, test } from "bun:test";
import { analyzeShell } from "../src/shell-analysis";

describe("Tree-sitter shell analysis", () => {
  test("emits only statically provable file references", async () => {
    // Given every supported static reference form plus path-looking non-operands.
    const command = [
      "./bin/tool arbitrary/path",
      "bash 'quoted script.sh'",
      "bash -- second.sh",
      "source ./setup.sh",
      ". \"./profile\"",
      "cat < ./input",
      "cat 0< /tmp/absolute-input",
      "echo output > /tmp/not-input",
    ].join("; ");

    // When the command is analyzed once.
    const analysis = await analyzeShell(command, "/workspace");

    // Then references retain their typed origin, raw spelling, segment, and cwd.
    expect(analysis.staticFileReferences).toEqual([
      { kind: "executable", raw: "./bin/tool", value: "./bin/tool", topLevelSegment: 0, cwd: "/workspace" },
      { kind: "shell_script", raw: "'quoted script.sh'", value: "quoted script.sh", topLevelSegment: 1, cwd: "/workspace" },
      { kind: "shell_script", raw: "second.sh", value: "second.sh", topLevelSegment: 2, cwd: "/workspace" },
      { kind: "source", raw: "./setup.sh", value: "./setup.sh", topLevelSegment: 3, cwd: "/workspace" },
      { kind: "source", raw: "\"./profile\"", value: "./profile", topLevelSegment: 4, cwd: "/workspace" },
      { kind: "input_redirect", raw: "./input", value: "./input", topLevelSegment: 5, cwd: "/workspace" },
      { kind: "input_redirect", raw: "/tmp/absolute-input", value: "/tmp/absolute-input", topLevelSegment: 6, cwd: "/workspace" },
    ]);
  });

  test("excludes ambiguous script candidates and references after cwd changes", async () => {
    // Given options, dynamic words, globbing, tilde expansion, nested strings, and a top-level cd.
    const command = [
      "bash -x script.sh",
      "bash --rcfile rc script.sh",
      "bash --init-file=rc script.sh",
      "bash -O extglob script.sh",
      "bash *.sh",
      "source ~/profile",
      "sh -c './nested-tool'",
      "cd /tmp",
      "cat < ./relative-input",
      "/tmp/absolute-tool",
    ].join("; ");

    // When static references are extracted from the authoritative analysis.
    const references = (await analyzeShell(command, "/workspace")).staticFileReferences;

    // Then only the absolute executable after cd remains provable.
    expect(references).toEqual([
      { kind: "executable", raw: "/tmp/absolute-tool", value: "/tmp/absolute-tool", topLevelSegment: 9, cwd: "/tmp" },
    ]);
  });

  test("recursively analyzes clustered shell -c options", async () => {
    for (const command of [
      "sh -ec 'echo payload | sh'",
      "bash -lc 'echo payload | sh'",
      "zsh -fc 'echo payload | sh'",
      "dash -ec 'echo payload | sh'",
      "busybox sh -ec 'echo payload | sh'",
    ]) {
      const analysis = await analyzeShell(command);
      expect(analysis.nestedAnalyses, command).toHaveLength(1);
      expect(analysis.nestedAnalyses[0]?.segments.map((segment) => segment.commandName), command).toEqual([
        "echo",
        "sh",
      ]);
    }
  });

  test("reviews ambiguous executable word and nested script forms", async () => {
    for (const command of ["$'rm' -rf /", `sh -ec "echo payload | sh"`, "eval echo ok", "source script.sh", ". script.sh", "exec echo ok"]) {
      expect((await analyzeShell(command)).issues.length, command).toBeGreaterThan(0);
    }
  });

  test.each(["echo '", "echo |", "echo &&", "cat <<EOF\nbody", "echo $(id", "echo >"])(
    "reviews malformed syntax: %s",
    async (command) => {
      const analysis = await analyzeShell(command);
      expect(analysis.issues.length).toBeGreaterThan(0);
    },
  );

  test.each(["echo $(id)", "echo ok &", "for x in a; do echo $x; done"])(
    "reviews dynamic or unsupported syntax: %s",
    async (command) => {
      const analysis = await analyzeShell(command);
      expect(analysis.issues.length).toBeGreaterThan(0);
    },
  );

  test.each([
    "PATH=.; xcodebuildmcp tools",
    "HOME=.; xcodebuildmcp tools",
    "SAFE=1; xcodebuildmcp tools",
  ])("reviews standalone shell-state assignment: %s", async (command) => {
    expect((await analyzeShell(command)).issues.some((entry) => entry.reason.includes("standalone variable"))).toBe(true);
  });

  test("collects redirections across compound, pipeline, logical, and standalone statements", async () => {
    for (const command of [
      "(echo hi) > output",
      "{ echo hi; } > output",
      "! echo hi > output",
      "echo hi | grep hi > output",
      "echo hi && grep hi > output",
      "> output; echo hi",
    ]) {
      const analysis = await analyzeShell(command);
      expect(analysis.redirections, command).toContainEqual({
        operator: ">",
        target: { raw: "output", value: "output" },
      });
    }
  });

  test("uses byte spans for Unicode source", async () => {
    const analysis = await analyzeShell("echo '你好 | 世界' | grep 世界");
    expect(analysis.issues).toEqual([]);
    expect(analysis.segments.map((segment) => segment.source)).toEqual(["echo '你好 | 世界'", "grep 世界"]);
    expect(analysis.segments[0]?.endByte).toBe(Buffer.byteLength("echo '你好 | 世界'", "utf8"));
    expect(analysis.segments[1]?.startByte).toBe(Buffer.byteLength("echo '你好 | 世界' | ", "utf8"));
  });

  test("bounds control characters and input size", async () => {
    expect((await analyzeShell("echo \u0000secret")).issues.length).toBeGreaterThan(0);
    expect((await analyzeShell(`echo ${"x".repeat(128 * 1024)}`)).issues.length).toBeGreaterThan(0);
    const tooMany = await analyzeShell(Array.from({ length: 257 }, () => "true").join(";"));
    expect(tooMany.segments).toHaveLength(256);
    expect(tooMany.issues.some((entry) => entry.kind === "limit")).toBe(true);
  });

  test("parses concurrent calls with independent parser instances", async () => {
    const analyses = await Promise.all(Array.from({ length: 16 }, (_, index) => analyzeShell(`echo ${String(index)}`)));
    expect(analyses.map((analysis) => analysis.segments[0]?.source)).toEqual(
      Array.from({ length: 16 }, (_, index) => `echo ${String(index)}`),
    );
  });

  test("shares the executable-segment budget across nested shell analyses", async () => {
    const command = Array.from({ length: 100 }, () => "sh -c 'echo one; echo two'").join("; ");
    const analysis = await analyzeShell(command);
    expect(analysis.segments).toHaveLength(256);
    expect(analysis.nestedAnalyses.length).toBeLessThan(100);
    expect(analysis.issues.some((entry) => entry.kind === "limit")).toBe(true);
  });
});
