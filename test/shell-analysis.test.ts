import { describe, expect, test } from "bun:test";
import { analyzeShell } from "../src/shell-analysis";

describe("Tree-sitter shell analysis", () => {
  test("extracts static pipeline and list segments", async () => {
    const analysis = await analyzeShell("echo one | grep one && head -n 1; pwd");
    expect(analysis.issues).toEqual([]);
    expect(analysis.segments.map((segment) => segment.source)).toEqual([
      "echo one",
      "grep one",
      "head -n 1",
      "pwd",
    ]);
  });

  test("marks every executable inside a pipeline sink subtree", async () => {
    const analysis = await analyzeShell("printf payload | (true; sh)");
    expect(analysis.segments.map((segment) => [segment.commandName, segment.stdinFromPipe])).toEqual([
      ["printf", false],
      ["true", true],
      ["sh", true],
    ]);
  });

  test("accepts static assignments and safe descriptor redirects", async () => {
    for (const command of [
      "HOME=/tmp xcodebuildmcp tools",
      "xcrun simctl list 2>&1 | grep Booted",
      "xcodebuildmcp tools 2>/dev/null | grep simulator",
    ]) {
      expect((await analyzeShell(command)).issues, command).toEqual([]);
    }
    expect((await analyzeShell("xcodebuildmcp tools > output")).issues).toEqual([]);
    expect((await analyzeShell("xcodebuildmcp tools > output")).redirections).toEqual([
      { operator: ">", target: { raw: "output", value: "output" } },
    ]);
    expect((await analyzeShell("cat < .env")).segments[0]?.redirections).toEqual([
      { operator: "<", target: { raw: ".env", value: ".env" } },
    ]);
  });

  test("keeps quoted and escaped operators inside one segment", async () => {
    const quoted = await analyzeShell("echo 'left | right; still data'");
    const escaped = await analyzeShell("echo left\\|right");
    expect(quoted.issues).toEqual([]);
    expect(quoted.segments.map((segment) => segment.source)).toEqual(["echo 'left | right; still data'"]);
    expect(escaped.issues).toEqual([]);
    expect(escaped.segments).toHaveLength(1);
  });

  test("cooks static shell words without losing their raw spelling", async () => {
    const analysis = await analyzeShell(`g""it commit --n\\o-verify --no-"verify" ~/.s\\sh/id_rsa`);
    expect(analysis.issues).toEqual([]);
    expect(analysis.segments[0]).toMatchObject({
      commandName: "git",
      arguments: ["commit", "--no-verify", "--no-verify", "~/.ssh/id_rsa"],
      rawArguments: ["commit", "--n\\o-verify", `--no-"verify"`, "~/.s\\sh/id_rsa"],
    });
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
