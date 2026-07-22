import { describe, expect, test } from "bun:test";
import { analyzeShell } from "../src/shell-analysis";

const referenceFacts = async (command: string): Promise<readonly unknown[]> =>
  (await analyzeShell(command, "/workspace")).staticFileReferences.map(({ kind, value, topLevelSegment, cwd }) =>
    ({ kind, value, topLevelSegment, cwd }),
  );

const executableFacts = async (command: string): Promise<readonly unknown[]> =>
  (await analyzeShell(command, "/workspace")).staticFileReferences
    .filter((reference) => reference.kind === "executable")
    .map(({ value, cwd }) => ({ value, cwd }));

describe("static file references", () => {
  test("keeps sequential cd ambiguity isolated from the parent shell", async () => {
    // Given an ambiguous cd sequence inside a subshell followed by a parent command.
    const command = "(cd /tmp; ./middle); ./parent";

    // When child and parent executable references are collected.
    const references = await executableFacts(command);

    // Then the child-relative path is omitted and the restored parent cwd remains exact.
    expect(references).toEqual([{ value: "./parent", cwd: "/workspace" }]);
  });

  test.each([
    "echo $(cd /tmp; ./inside); ./parent",
    "echo <(cd /tmp; ./inside); ./parent",
  ])("keeps sequential cd ambiguity inside a substitution: %s", async (command) => {
    // Given a substitution with an unguarded cd sequence and a later parent command.
    const references = await executableFacts(command);

    // When relative executable evidence is attributed.
    // Then the ambiguous child path is omitted without affecting the parent.
    expect(references).toEqual([{ value: "./parent", cwd: "/workspace" }]);
  });

  test.each([
    ["(cd /tmp && ./success)", "./success", "/tmp"],
    ["(cd /definitely-missing || ./fallback)", "./fallback", "/workspace"],
    ["(cd /definitely-missing || env -C relative ./fallback)", "./fallback", "/workspace/relative"],
    ["(true && cd /tmp && ./success)", "./success", "/tmp"],
    ["(false || cd /tmp && ./success)", "./success", "/tmp"],
  ])("attributes a conditional operand from the status path that reaches it: %s", async (command, value, cwd) => {
    // Given a conditional command whose right operand runs on exactly one left outcome.
    const analysis = await analyzeShell(command, "/workspace");

    // When the reached relative executable is selected.
    const reference = analysis.staticFileReferences.find((candidate) => candidate.value === value);

    // Then it resolves from the success or failure state required by its connector.
    expect(reference?.cwd).toBe(cwd);
    expect(analysis.segments.find((segment) => segment.source.includes(value))?.executionCwd).toBe(cwd);
  });

  test.each([
    ["(false && cd /tmp; ./tool)", ["./tool"]],
    ["(true || cd /tmp; ./tool)", ["./tool"]],
    ["(false && ./never; ./tool)", ["./tool"]],
    ["(true || ./never; ./tool)", ["./tool"]],
  ])("does not apply an unreachable conditional branch: %s", async (command, expectedValues) => {
    // Given a known true or false command that makes one branch unreachable.
    const references = (await analyzeShell(command, "/workspace")).staticFileReferences;

    // When executable evidence is collected across the conditional and following sequence.
    // Then the unreachable branch emits and mutates nothing, while the following command keeps the prior cwd.
    expect(references.map((reference) => reference.value)).toEqual(expectedValues);
    expect(references.map((reference) => reference.cwd)).toEqual(expectedValues.map(() => "/workspace"));
  });

  test.each([
    ["(! true && cd /tmp; ./tool)", ["./tool"], ["/workspace"]],
    ["(! false && cd /tmp && ./success)", ["./success"], ["/tmp"]],
    ["(unknown && true; ./tool)", ["./tool"], ["/workspace"]],
    ["(unknown || false; ./tool)", ["./tool"], ["/workspace"]],
  ])("preserves status inversion and equal-state joins: %s", async (command, expectedValues, expectedCwds) => {
    // Given a negated known status or an unknown branch whose cwd outcomes are equal.
    const references = (await analyzeShell(command, "/workspace")).staticFileReferences;

    // When the conditional result reaches a later relative executable.
    // Then unreachable mutation stays suppressed and equal cwd states remain provable.
    expect(references.map((reference) => reference.value)).toEqual(expectedValues);
    expect(references.map((reference) => reference.cwd)).toEqual(expectedCwds);
  });

  test("does not assume true succeeds when its redirection can fail", async () => {
    // Given a nominally successful builtin whose input redirect may fail before execution.
    const command = "(true < /definitely-missing || ./fallback)";

    // When both the redirect and conditional fallback are analyzed.
    const references = (await analyzeShell(command, "/workspace")).staticFileReferences;

    // Then the failure path remains reachable from the unchanged cwd.
    expect(references.map(({ kind, value, cwd }) => ({ kind, value, cwd }))).toEqual([
      { kind: "input_redirect", value: "/definitely-missing", cwd: "/workspace" },
      { kind: "executable", value: "./fallback", cwd: "/workspace" },
    ]);
  });

  test.each([
    "(unknown && cd /tmp; ./ambiguous; /bin/absolute)",
    "(unknown || cd /tmp; ./ambiguous; /bin/absolute)",
    "(true && cd /tmp; ./ambiguous; /bin/absolute)",
    "(false || cd /tmp; ./ambiguous; /bin/absolute)",
    "(cd /tmp || cd /var; ./ambiguous; /bin/absolute)",
  ])("omits relative evidence after unequal conditional cwd states: %s", async (command) => {
    // Given a conditional whose reachable outcomes do not prove one post-join cwd.
    const references = (await analyzeShell(command, "/workspace")).staticFileReferences;

    // When commands after the conditional join are inspected.
    // Then relative evidence is omitted while an absolute executable reference remains available.
    expect(references.map((reference) => reference.value)).not.toContain("./ambiguous");
    expect(references.map((reference) => reference.value)).toContain("/bin/absolute");
  });

  test.each([
    "echo $(cd /definitely-missing || ./inside); ./parent",
    "echo <(cd /definitely-missing || ./inside); ./parent",
  ])("propagates failure-path cwd inside an isolated substitution: %s", async (command) => {
    // Given a child-shell substitution with a cd failure fallback and a parent command.
    const references = (await analyzeShell(command, "/workspace")).staticFileReferences
      .filter((reference) => reference.value === "./inside" || reference.value === "./parent");

    // When child and parent paths are attributed.
    // Then the fallback and restored parent both use the unchanged cwd.
    expect(references.map(({ value, cwd }) => ({ value, cwd }))).toEqual([
      { value: "./inside", cwd: "/workspace" },
      { value: "./parent", cwd: "/workspace" },
    ]);
  });

  test.each([
    "(cd $(./before); ./after)",
    "(cd /tmp <(./before); ./after)",
  ])("evaluates substitutions before applying the enclosing command cwd effect: %s", async (command) => {
    // Given a cwd-changing command whose operand contains a child-shell substitution.
    const references = (await analyzeShell(command, "/workspace")).staticFileReferences;

    // When substitution and later-command references are collected.
    // Then the substitution sees the pre-command cwd and an unknown cd result does not lease the later relative path.
    expect(references.map(({ value, cwd }) => ({ value, cwd }))).toEqual([
      { value: "./before", cwd: "/workspace" },
    ]);
  });

  test("isolates conditional flow state inside one pipeline child", async () => {
    // Given a compound pipeline child containing a failed-cd fallback.
    const command = "{ cd /definitely-missing || ./fallback; } | ./peer; ./parent";

    // When executable references are attributed across both children and the parent.
    const references = await referenceFacts(command);

    // Then failure state stays in its branch and no pipeline state leaks outward.
    expect(references).toEqual([
      { kind: "executable", value: "./fallback", topLevelSegment: 1, cwd: "/workspace" },
      { kind: "executable", value: "./peer", topLevelSegment: 2, cwd: "/workspace" },
      { kind: "executable", value: "./parent", topLevelSegment: 3, cwd: "/workspace" },
    ]);
  });

  test.each([
    "(./cd /tmp; ./tool)",
    "(env cd /tmp; ./tool)",
    "(sudo cd /tmp; ./tool)",
    "(command /bin/cd /tmp; ./tool)",
  ])("does not mutate nested cwd for an external cd dispatch: %s", async (command) => {
    // Given an external same-name command inside a nested shell scope.
    const references = (await analyzeShell(command, "/workspace")).staticFileReferences;

    // When the later executable reference is selected.
    const tool = references.find((reference) => reference.value === "./tool");

    // Then it remains bound to the unchanged nested scope cwd.
    expect(tool?.cwd).toBe("/workspace");
  });

  test.each([
    "echo $(cd /tmp && ./inside); ./parent",
    "echo <(cd /tmp && ./inside); ./parent",
  ])("isolates parser-represented child shell state: %s", async (command) => {
    // Given a function, command substitution, or process substitution with an absolute cd.
    const references = (await analyzeShell(command, "/workspace")).staticFileReferences
      .filter((reference) => reference.value === "./inside" || reference.value === "./parent");

    // When child and parent executable cwd values are inspected.
    // Then the child may establish an exact cwd without leaking it to the parent shell.
    expect(references.map(({ value, cwd }) => ({ value, cwd }))).toEqual([
      { value: "./inside", cwd: "/tmp" },
      { value: "./parent", cwd: "/workspace" },
    ]);
  });

  test("does not lease paths from a merely defined function body", async () => {
    // Given a function definition containing every supported relative reference kind.
    const command = "f() { cd /tmp; ./inside; sh ./script; source ./profile; cat < ./input; }; ./parent";

    // When the definition and later parent command are analyzed without invoking the function.
    const references = await referenceFacts(command);

    // Then only the actually executed parent command contributes evidence.
    expect(references).toEqual([
      { kind: "executable", value: "./parent", topLevelSegment: 5, cwd: "/workspace" },
    ]);
  });

  test("keeps a top-level brace group in the conservative parent scope", async () => {
    // Given a same-shell brace group that performs a true top-level cd.
    const command = "{ cd /tmp; ./blocked; }; /bin/absolute; cat < ./blocked-input";

    // When later relative and absolute references are collected.
    const references = await referenceFacts(command);

    // Then the plan's top-level cutoff excludes relative evidence while retaining absolute evidence.
    expect(references).toEqual([
      { kind: "executable", value: "/bin/absolute", topLevelSegment: 2, cwd: "/tmp" },
    ]);
  });

});
