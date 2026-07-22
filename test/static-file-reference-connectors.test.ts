import { describe, expect, test } from "bun:test";
import { analyzeShell } from "../src/shell-analysis";

const referenceValues = async (command: string): Promise<readonly string[]> =>
  (await analyzeShell(command, "/workspace")).staticFileReferences.map((reference) =>
    `${reference.kind}:${reference.raw}:${reference.value}`,
  );

describe("static file references", () => {
  test("retains connector and syntax nesting facts", async () => {
    // Given sequence, logical, pipeline, and subshell connectors.
    const analysis = await analyzeShell("a; b && c || d | (e)", "/workspace");

    // When the executable segments are collected.
    const facts = analysis.segments.map((segment) => ({
      source: segment.source,
      connector: segment.connector,
      topLevel: segment.topLevel,
      subshellDepth: segment.subshellDepth,
    }));

    // Then each segment remains bound to its connector and nesting context.
    expect(facts).toEqual([
      { source: "a", connector: "start", topLevel: true, subshellDepth: 0 },
      { source: "b", connector: "sequence", topLevel: true, subshellDepth: 0 },
      { source: "c", connector: "and", topLevel: true, subshellDepth: 0 },
      { source: "d", connector: "or", topLevel: true, subshellDepth: 0 },
      { source: "e", connector: "pipe", topLevel: false, subshellDepth: 1 },
    ]);
  });

  test("excludes relative references after wrapped top-level cd", async () => {
    // Given a shell-builtin wrapper that still changes the parent shell cwd.
    const command = "builtin cd /tmp; cat < ./relative-input";

    // When static references are collected after the directory change.
    const references = await referenceValues(command);

    // Then the later relative input is not authorized against the original cwd.
    expect(references).toEqual([]);
  });

  test.each([
    "cd /tmp; cat < ./input",
    "command cd /tmp; cat < ./input",
    "builtin cd /tmp; cat < ./input",
  ])("cuts off relative references only after a proven parent-shell cd: %s", async (command) => {
    // Given a direct or explicitly dispatched shell builtin cd.
    // When a later relative input would depend on changed parent-shell state.
    // Then it is conservatively excluded from evidence resolved against the original cwd.
    expect(await referenceValues(command)).toEqual([]);
  });

  test.each([
    ["./cd /tmp; cat < ./input", ["executable:./cd:./cd", "input_redirect:./input:./input"]],
    ["env cd /tmp; cat < ./input", ["input_redirect:./input:./input"]],
    ["sudo cd /tmp; cat < ./input", ["input_redirect:./input:./input"]],
    ["nice cd /tmp; cat < ./input", ["input_redirect:./input:./input"]],
    ["command /bin/cd /tmp; cat < ./input", ["executable:/bin/cd:/bin/cd", "input_redirect:./input:./input"]],
    ["(cd /tmp); cat < ./input", ["input_redirect:./input:./input"]],
    ["cd /tmp | true; cat < ./input", ["input_redirect:./input:./input"]],
  ])("does not attribute an external or isolated cd to the parent shell: %s", async (command, expected) => {
    // Given a same-named external command, child process, subshell, or pipeline builtin.
    // When later relative evidence is collected in the unchanged parent shell.
    // Then the relative input remains attributable to the original analysis cwd.
    expect(await referenceValues(command)).toEqual(expected);
  });

  test("does not treat brace-expanded executable paths as static", async () => {
    // Given an executable token that expands to multiple paths.
    // When the shell command is analyzed.
    // Then no executable reference is emitted from the expansion.
    expect(await referenceValues("./{one,two}")).toEqual([]);
  });
});
