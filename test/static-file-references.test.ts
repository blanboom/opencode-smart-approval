import { describe, expect, test } from "bun:test";
import { compileRule } from "../src/rule-compiler";
import { evaluateRulesFromAnalysis } from "../src/rules";
import { analyzeShell } from "../src/shell-analysis";

const referenceValues = async (command: string): Promise<readonly string[]> =>
  (await analyzeShell(command, "/workspace")).staticFileReferences.map((reference) =>
    `${reference.kind}:${reference.raw}:${reference.value}`,
  );

const referenceFacts = async (command: string): Promise<readonly unknown[]> =>
  (await analyzeShell(command, "/workspace")).staticFileReferences.map(({ kind, value, topLevelSegment, cwd }) =>
    ({ kind, value, topLevelSegment, cwd }),
  );

const executableFacts = async (command: string): Promise<readonly unknown[]> =>
  (await analyzeShell(command, "/workspace")).staticFileReferences
    .filter((reference) => reference.kind === "executable")
    .map(({ value, cwd }) => ({ value, cwd }));

describe("static file references", () => {
  test.each([
    ["< /tmp/input cat", "cat", []],
    ["cat < /tmp/input", "cat", []],
    ["< /tmp/input cat arg", "cat", ["arg"]],
    ["cat arg < /tmp/input", "cat", ["arg"]],
  ])("keeps a plain stdin redirect outside command identity: %s", async (command, commandName, args) => {
    // Given a plain prefix or suffix stdin redirect around one ordinary command.
    const analysis = await analyzeShell(command, "/workspace");

    // When the authoritative command segment and file reference are projected.
    const segment = analysis.segments[0];
    const inputs = analysis.staticFileReferences.filter((reference) => reference.kind === "input_redirect");

    // Then existing command identity is unchanged and the redirect target is owned exactly once.
    expect(segment?.effectiveExecutable.value).toBe(commandName);
    expect(segment?.arguments).toEqual(args);
    expect(inputs.map(({ raw, value }) => ({ raw, value }))).toEqual([{ raw: "/tmp/input", value: "/tmp/input" }]);
  });

  test.each([
    ["0< /tmp/input cat", "cat", [], [], [{ raw: "/tmp/input", value: "/tmp/input" }]],
    ["0</tmp/input cat", "cat", [], [], [{ raw: "/tmp/input", value: "/tmp/input" }]],
    ["ROUND10=value 0< /tmp/input cat", "cat", [], [{ name: "ROUND10", value: "value" }], [{ raw: "/tmp/input", value: "/tmp/input" }]],
    ["0< '/tmp/input file' cat", "cat", [], [], [{ raw: "'/tmp/input file'", value: "/tmp/input file" }]],
    ["cat 0< /tmp/input", "cat", [], [], [{ raw: "/tmp/input", value: "/tmp/input" }]],
    ["cat 0</tmp/input", "cat", [], [], [{ raw: "/tmp/input", value: "/tmp/input" }]],
    ["cat 0< '/tmp/input file' arg", "cat", ["arg"], [], [{ raw: "'/tmp/input file'", value: "/tmp/input file" }]],
    [
      "0< /tmp/one 0< '/tmp/two' cat arg",
      "cat",
      ["arg"],
      [],
      [{ raw: "/tmp/one", value: "/tmp/one" }, { raw: "'/tmp/two'", value: "/tmp/two" }],
    ],
  ])("keeps explicit stdin descriptors out of identity and arguments: %s", async (
    command,
    commandName,
    args,
    assignments,
    expectedInputs,
  ) => {
    // Given a valid explicit-fd redirect before, after, or between ordinary command words.
    const analysis = await analyzeShell(command, "/workspace");

    // When identity, arguments, assignments, and typed inputs are read from the same AST traversal.
    const segment = analysis.segments[0];
    const inputs = analysis.staticFileReferences
      .filter((reference) => reference.kind === "input_redirect")
      .map(({ raw, value }) => ({ raw, value }));

    // Then fd/operator/target syntax is excluded while every exact input target remains in source order.
    expect(analysis.segments).toHaveLength(1);
    expect(segment?.originalExecutable.value).toBe(commandName);
    expect(segment?.effectiveExecutable.value).toBe(commandName);
    expect(segment?.arguments).toEqual(args);
    expect(segment?.assignments.map(({ name, value }) => ({ name, value }))).toEqual(assignments);
    expect(inputs).toEqual(expectedInputs);
  });

  test.each([
    ["0< /tmp/input", ["/tmp/input"]],
    ["ROUND10=value 0< /tmp/input", ["/tmp/input"]],
    ["0< /tmp/one 0< '/tmp/two'", ["/tmp/one", "/tmp/two"]],
  ])("does not invent a command for explicit-fd input-only syntax: %s", async (command, expectedInputs) => {
    // Given one or more input redirects with no executable word.
    const analysis = await analyzeShell(command, "/workspace");

    // When command segments and typed file evidence are collected.
    // Then no descriptor becomes executable identity and each input target is emitted once.
    expect(analysis.segments).toEqual([]);
    expect(analysis.staticFileReferences.map((reference) => reference.value)).toEqual(expectedInputs);
  });

  test.each([
    ["0> /tmp/output cat", "cat"],
    ["1< /tmp/not-stdin cat", "cat"],
    ["2< /tmp/not-stdin cat", "cat"],
  ])("excludes explicit non-input redirects without corrupting identity: %s", async (command, commandName) => {
    // Given an explicit output or non-stdin file descriptor before a command.
    const analysis = await analyzeShell(command, "/workspace");

    // When identity and readable input evidence are projected.
    // Then the command remains exact and no target is leased as stdin.
    expect(analysis.segments.map((segment) => segment.effectiveExecutable.value)).toEqual([commandName]);
    expect(analysis.segments[0]?.arguments).toEqual([]);
    expect(analysis.staticFileReferences).toEqual([]);
  });

  test("retains wrapper identity and source-ordered evidence after a prefix descriptor", async () => {
    // Given an explicit stdin descriptor followed by a normalized wrapper invocation.
    const analysis = await analyzeShell("0< /tmp/input A=x /usr/bin/env -i /bin/cat arg", "/workspace");
    const segment = analysis.segments[0];

    // When wrapper reduction and static-reference collection consume the recovered command words.
    // Then the wrapper, target, argument, and redirect retain their distinct authoritative positions.
    expect(segment?.originalExecutable.value).toBe("/usr/bin/env");
    expect(segment?.effectiveExecutable.value).toBe("/bin/cat");
    expect(segment?.arguments).toEqual(["-i", "/bin/cat", "arg"]);
    expect(segment?.assignments.map(({ name, value }) => ({ name, value }))).toEqual([{ name: "A", value: "x" }]);
    expect(analysis.staticFileReferences.map(({ kind, value }) => ({ kind, value }))).toEqual([
      { kind: "executable", value: "/usr/bin/env" },
      { kind: "executable", value: "/bin/cat" },
      { kind: "input_redirect", value: "/tmp/input" },
    ]);
  });

  test.each([
    ["0 < /tmp/input cat", "0", ["cat"]],
    ["cat 0 < /tmp/input", "cat", ["0"]],
  ])("does not consume a whitespace-separated number as a descriptor: %s", async (command, commandName, args) => {
    // Given a numeric command word or argument separated from a later redirect operator.
    const analysis = await analyzeShell(command, "/workspace");

    // When source-span adjacency determines descriptor ownership.
    // Then the real numeric word remains in command identity or arguments.
    expect(analysis.segments[0]?.effectiveExecutable.value).toBe(commandName);
    expect(analysis.segments[0]?.arguments).toEqual(args);
    expect(analysis.staticFileReferences.map((reference) => reference.value)).toEqual(["/tmp/input"]);
  });

  test("fails closed for a dynamic command after a prefix descriptor", async () => {
    // Given a static stdin target followed by a dynamically constructed command name.
    const analysis = await analyzeShell("0< /tmp/input $command", "/workspace");

    // When authoritative identity and static evidence are collected.
    // Then no command identity is guessed, while the independently static redirect remains attributable.
    expect(analysis.segments).toEqual([]);
    expect(analysis.staticFileReferences.map((reference) => reference.value)).toEqual(["/tmp/input"]);
    expect(analysis.issues).toContainEqual(expect.objectContaining({ kind: "dynamic" }));
  });

  test.each([
    ["0< /tmp/input cat A=x", ["A=x"]],
    ["0< /tmp/input cat A='x y'", ["A=x y"]],
    ["0< /tmp/input cat PATH=./untrusted", ["PATH=./untrusted"]],
  ])("keeps assignment-shaped words after the command name as arguments: %s", async (command, args) => {
    // Given assignment-shaped words that occur after an already established command name.
    const segment = (await analyzeShell(command, "/workspace")).segments[0];

    // When leading shell assignments and ordinary arguments are separated.
    // Then post-command words remain arguments and do not mutate execution identity.
    expect(segment?.effectiveExecutable.value).toBe("cat");
    expect(segment?.arguments).toEqual(args);
    expect(segment?.assignments).toEqual([]);
  });

  test.each([
    ["0< /tmp/input A=x cat", "cat", [], [{ name: "A", value: "x" }], ["/tmp/input"]],
    ["0< /tmp/input A+=x cat", "cat", [], [{ name: "A", value: "x" }], ["/tmp/input"]],
    ["0< /tmp/input A='x y' cat", "cat", [], [{ name: "A", value: "x y" }], ["/tmp/input"]],
    ["A=x 0< /tmp/input B=y /bin/cat arg", "/bin/cat", ["arg"], [{ name: "A", value: "x" }, { name: "B", value: "y" }], ["/bin/cat", "/tmp/input"]],
    [
      "0< /tmp/one A=x 0< '/tmp/two' B=\"y z\" /bin/cat arg",
      "/bin/cat",
      ["arg"],
      [{ name: "A", value: "x" }, { name: "B", value: "y z" }],
      ["/bin/cat", "/tmp/one", "/tmp/two"],
    ],
    ["0> /tmp/output A=x cat", "cat", [], [{ name: "A", value: "x" }], []],
    ["0< /tmp/input PATH=./untrusted ls", "ls", [], [{ name: "PATH", value: "./untrusted" }], ["/tmp/input"]],
    ["0< /tmp/input LD_PRELOAD=./evil.so /bin/ls", "/bin/ls", [], [{ name: "LD_PRELOAD", value: "./evil.so" }], ["/bin/ls", "/tmp/input"]],
    ["0< /tmp/input DYLD_INSERT_LIBRARIES=./evil.dylib /bin/ls", "/bin/ls", [], [{ name: "DYLD_INSERT_LIBRARIES", value: "./evil.dylib" }], ["/bin/ls", "/tmp/input"]],
  ])("classifies leading assignments recovered after redirects: %s", async (
    command,
    commandName,
    args,
    assignments,
    expectedReferences,
  ) => {
    // Given leading assignments interleaved with prefix or multiple redirect syntax.
    const analysis = await analyzeShell(command, "/workspace");
    const segment = analysis.segments[0];

    // When recovered AST words form the authoritative invocation.
    // Then assignments precede the actual executable, preserve values, and disable terminal allow.
    expect(segment?.originalExecutable.value).toBe(commandName);
    expect(segment?.effectiveExecutable.value).toBe(commandName);
    expect(segment?.arguments).toEqual(args);
    expect(segment?.assignments.map(({ name, value }) => ({ name, value }))).toEqual(assignments);
    expect(segment?.terminalAllowEligible).toBe(false);
    expect(analysis.staticFileReferences.map((reference) => reference.value)).toEqual(expectedReferences);
  });

  test.each([
    ["0< /tmp/input A=x", ["/tmp/input"]],
    ["A=x 0< /tmp/one B='y z' 0< /tmp/two", ["/tmp/one", "/tmp/two"]],
  ])("does not invent a command for assignment-only interleaved redirects: %s", async (command, expectedInputs) => {
    // Given redirects interleaved only with leading shell assignments.
    const analysis = await analyzeShell(command, "/workspace");

    // When identity and input evidence are collected.
    // Then no assignment becomes executable and every static input remains attributable.
    expect(analysis.segments).toEqual([]);
    expect(analysis.staticFileReferences.map((reference) => reference.value)).toEqual(expectedInputs);
  });

  test("keeps a post-redirect PATH modifier out of segment allow fast paths", async () => {
    // Given a misleading segment rule matching the visible assignment plus low-risk command.
    const command = "0< /tmp/input PATH=./untrusted ls";
    const analysis = await analyzeShell(command, "/workspace");
    const rule = compileRule({ label: "misleading", match: "^PATH=\\./untrusted ls$", decision: "allow", scope: "segment" });

    // When the rule consumes the authoritative modified invocation.
    // Then assignment identity prevents a terminal segment allow bypass.
    expect(evaluateRulesFromAnalysis([rule], command, analysis).decision).toBe("review");
  });

});
