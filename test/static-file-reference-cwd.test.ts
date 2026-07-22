import { describe, expect, test } from "bun:test";
import { analyzeShell } from "../src/shell-analysis";
import { projectReviewShellAnalysis } from "../src/review-shell-dto";

const referenceValues = async (command: string): Promise<readonly string[]> =>
  (await analyzeShell(command, "/workspace")).staticFileReferences.map((reference) =>
    `${reference.kind}:${reference.raw}:${reference.value}`,
  );

const referenceFacts = async (command: string): Promise<readonly unknown[]> =>
  (await analyzeShell(command, "/workspace")).staticFileReferences.map(({ kind, value, topLevelSegment, cwd }) =>
    ({ kind, value, topLevelSegment, cwd }),
  );

describe("static file references", () => {
  test.each([
    ["(cd /tmp && ./tool < ./input)", "./input", "/tmp"],
    ["(cd /definitely-missing || ./fallback < ./input)", "./input", "/workspace"],
    ["(cd /tmp && < ./input ./tool)", "./input", "/tmp"],
    ["(cd /tmp && ./tool < ./one < './two')", "./one,./two", "/tmp"],
    ["(cd /tmp && (cd relative && ./tool < ./input))", "./input", "/tmp/relative"],
  ])("attributes a conditional command redirect from its reached shell cwd: %s", async (command, values, cwd) => {
    // Given redirects on a right-hand conditional command reached after an exact cwd transition.
    const inputs = (await analyzeShell(command, "/workspace")).staticFileReferences
      .filter((reference) => reference.kind === "input_redirect");

    // When the owning branch command claims its redirect evidence.
    // Then every target resolves from that branch shell cwd, not the earlier left-command cwd.
    expect(inputs.map((reference) => reference.value).join(",")).toBe(values);
    expect(inputs.map((reference) => reference.cwd)).toEqual(values.split(",").map(() => cwd));
  });

  test("keeps wrapper process cwd distinct from its shell-opened redirect cwd", async () => {
    // Given a successful branch whose wrapper changes cwd only for the spawned process.
    const analysis = await analyzeShell("(cd /tmp && env -C relative ./tool < ./input)", "/workspace");

    // When executable and input evidence are attributed.
    // Then the process target uses wrapper cwd while the shell opens stdin from its pre-wrapper cwd.
    expect(analysis.staticFileReferences.map(({ kind, value, cwd }) => ({ kind, value, cwd }))).toEqual([
      { kind: "executable", value: "./tool", cwd: "/tmp/relative" },
      { kind: "input_redirect", value: "./input", cwd: "/tmp" },
    ]);
  });

  test.each([
    ["(cd /tmp; ./tool < ./input)", "./input"],
    ["(cd /tmp; < ./input ./tool)", "./input"],
  ])("omits a relative redirect after an ambiguous sequential cwd: %s", async (command, input) => {
    // Given an unguarded cd whose success and failure paths reach one redirected command.
    const values = (await analyzeShell(command, "/workspace")).staticFileReferences.map((reference) => reference.value);

    // When no single cwd is proven for relative evidence.
    // Then neither the relative executable nor its relative input target is leased.
    expect(values).not.toContain("./tool");
    expect(values).not.toContain(input);
  });

  test("retains an absolute redirect after an ambiguous sequential cwd", async () => {
    // Given an unguarded cwd change followed by relative execution and an absolute input target.
    const references = (await analyzeShell("(cd /tmp; ./tool < /tmp/absolute-input)", "/workspace")).staticFileReferences;

    // When relative cwd becomes unknown.
    // Then the relative executable is omitted but the cwd-independent absolute target remains.
    expect(references.map((reference) => reference.value)).toEqual(["/tmp/absolute-input"]);
  });

  test.each([
    ["'./quoted tool'", ["executable:'./quoted tool':./quoted tool"]],
    ["sh script.sh", ["shell_script:script.sh:script.sh"]],
    ["bash '*.sh'", ["shell_script:'*.sh':*.sh"]],
    ["zsh -- -script.sh", ["shell_script:-script.sh:-script.sh"]],
    ["source './setup file'", ["source:'./setup file':./setup file"]],
    [". \"./profile\"", ["source:\"./profile\":./profile"]],
    ["cat < './input file'", ["input_redirect:'./input file':./input file"]],
    ["cat 0< \"./input\"", ["input_redirect:\"./input\":./input"]],
  ])("emits a qualifying static operand: %s", async (command, expected) => {
    // Given one expansion-free operand in a supported execution position.
    // When the authoritative shell analysis extracts file references.
    // Then raw quoting and cooked value remain attributable to that position.
    expect(await referenceValues(command)).toEqual(expected);
  });

  test("propagates a subshell-local cd to later references in that scope", async () => {
    // Given a subshell that changes cwd before an executable and input redirect.
    const command = "(cd /tmp && { ./tool; cat < ./input; })";

    // When typed references and segment nesting facts are inspected.
    const analysis = await analyzeShell(command, "/workspace");

    // Then both references resolve in the subshell cwd and retain their owning segment indexes.
    expect(analysis.staticFileReferences.map(({ kind, value, topLevelSegment, cwd }) =>
      ({ kind, value, topLevelSegment, cwd }))).toEqual([
      { kind: "executable", value: "./tool", topLevelSegment: 1, cwd: "/tmp" },
      { kind: "input_redirect", value: "./input", topLevelSegment: 2, cwd: "/tmp" },
    ]);
    expect(analysis.segments.map(({ source, topLevel, subshellDepth, executionCwd }) =>
      ({ source, topLevel, subshellDepth, executionCwd }))).toEqual([
      { source: "cd /tmp", topLevel: false, subshellDepth: 1, executionCwd: "/workspace" },
      { source: "./tool", topLevel: false, subshellDepth: 1, executionCwd: "/tmp" },
      { source: "cat", topLevel: false, subshellDepth: 1, executionCwd: "/tmp" },
    ]);
  });

  test("attributes every supported reference kind after a nested cwd change", async () => {
    // Given executable, script, source, and stdin operands after one subshell-local cd.
    const command = "(cd /tmp && { ./tool; sh ./script.sh; source ./profile; cat < ./input; })";

    // When all supported static reference kinds are collected.
    const references = await referenceFacts(command);

    // Then every relative operand uses the exact nested cwd and its global segment index.
    expect(references).toEqual([
      { kind: "executable", value: "./tool", topLevelSegment: 1, cwd: "/tmp" },
      { kind: "shell_script", value: "./script.sh", topLevelSegment: 2, cwd: "/tmp" },
      { kind: "source", value: "./profile", topLevelSegment: 3, cwd: "/tmp" },
      { kind: "input_redirect", value: "./input", topLevelSegment: 4, cwd: "/tmp" },
    ]);
  });

  test("stacks and restores nested shell cwd scopes", async () => {
    // Given nested subshells with absolute then relative cd operations.
    const command = "(cd /tmp && { ./outer-before; (cd relative && ./inner); ./outer-after; }); ./parent";

    // When executable references cross both scope entry and restoration.
    const references = await referenceFacts(command);

    // Then inner cwd changes stay local and each enclosing scope resumes its prior cwd.
    expect(references).toEqual([
      { kind: "executable", value: "./outer-before", topLevelSegment: 1, cwd: "/tmp" },
      { kind: "executable", value: "./inner", topLevelSegment: 3, cwd: "/tmp/relative" },
      { kind: "executable", value: "./outer-after", topLevelSegment: 4, cwd: "/tmp" },
      { kind: "executable", value: "./parent", topLevelSegment: 5, cwd: "/workspace" },
    ]);
  });

  test.each([
    [
      "{ cd /tmp && ./inside; } | ./peer; ./parent",
      [
        { kind: "executable", value: "./inside", topLevelSegment: 1, cwd: "/tmp" },
        { kind: "executable", value: "./peer", topLevelSegment: 2, cwd: "/workspace" },
        { kind: "executable", value: "./parent", topLevelSegment: 3, cwd: "/workspace" },
      ],
    ],
    [
      "(cd /tmp && { ./inside | ./peer; ./after; })",
      [
        { kind: "executable", value: "./inside", topLevelSegment: 1, cwd: "/tmp" },
        { kind: "executable", value: "./peer", topLevelSegment: 2, cwd: "/tmp" },
        { kind: "executable", value: "./after", topLevelSegment: 3, cwd: "/tmp" },
      ],
    ],
    [
      "cd /tmp | ./peer; ./parent",
      [
        { kind: "executable", value: "./peer", topLevelSegment: 1, cwd: "/workspace" },
        { kind: "executable", value: "./parent", topLevelSegment: 2, cwd: "/workspace" },
      ],
    ],
  ])("isolates pipeline child cwd state: %s", async (command, expected) => {
    // Given pipeline children that may contain their own same-scope command sequence.
    // When their references and later parent-shell references are collected.
    // Then cwd mutation remains inside the one pipeline child that performed it.
    expect(await referenceFacts(command)).toEqual(expected);
  });

  test.each([
    ["(cd /tmp && ./and; ./sequence)", ["/tmp"]],
    ["(cd /tmp && { ./sequence && ./and; })", ["/tmp", "/tmp"]],
  ])("preserves only provable cwd across same-scope connectors: %s", async (command, expectedCwds) => {
    // Given logical or sequence connectors inside one subshell.
    // When later executable references are inspected in traversal order.
    // Then success-only commands use the successful cwd and ambiguous joins omit relative evidence.
    expect((await analyzeShell(command, "/workspace")).staticFileReferences.map((reference) => reference.cwd)).toEqual(expectedCwds);
  });

  test.each([
    "(cd /definitely-missing; ./middle; /bin/absolute)",
    "(command cd /tmp; ./middle; /bin/absolute)",
    "(builtin cd relative; ./middle; /bin/absolute)",
    "({ cd /tmp; ./middle; /bin/absolute; })",
    "(true; cd /tmp; ./middle; /bin/absolute)",
    "(cd /tmp; cd /tmp; ./middle; /bin/absolute)",
  ])("omits relative evidence after an unguarded sequential cd: %s", async (command) => {
    // Given a cwd-changing builtin followed by an unconditional sequence.
    const references = (await analyzeShell(command, "/workspace")).staticFileReferences;

    // When the success and failure cwd states join before the next command.
    // Then no single relative path is leased, while absolute evidence remains available.
    expect(references.map((reference) => reference.value)).not.toContain("./middle");
    expect(references.map((reference) => reference.value)).toContain("/bin/absolute");
  });

  test("does not project a concrete cwd after a fallible sequential cd", async () => {
    // Given a failed-or-successful cd join followed by wrapped relative and absolute executables.
    const analysis = await analyzeShell("cd /tmp; env ./middle; /bin/absolute", "/workspace");

    // When shell analysis is projected across the reviewer trust boundary.
    const projected = projectReviewShellAnalysis(analysis);

    // Then every post-join cwd is explicitly unknown, including wrappers and absolute references.
    expect(projected.segments.slice(1).map((segment) => ({
      source: segment.source,
      executionCwd: segment.execution_cwd,
      wrapperCwds: segment.wrapper_chain.map((wrapper) => wrapper.execution_cwd),
    }))).toEqual([
      { source: "env ./middle", executionCwd: null, wrapperCwds: [null] },
      { source: "/bin/absolute", executionCwd: null, wrapperCwds: [] },
    ]);
    expect(projected.static_file_references).toEqual([
      expect.objectContaining({ value: "/bin/absolute", cwd: null }),
    ]);
  });

});
