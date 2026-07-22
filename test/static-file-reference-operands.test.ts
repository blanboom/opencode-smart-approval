import { describe, expect, test } from "bun:test";
import { analyzeShell } from "../src/shell-analysis";

const referenceValues = async (command: string): Promise<readonly string[]> =>
  (await analyzeShell(command, "/workspace")).staticFileReferences.map((reference) =>
    `${reference.kind}:${reference.raw}:${reference.value}`,
  );

describe("static file references", () => {
  test.each([
    ["/tmp/tool", ["executable:/tmp/tool:/tmp/tool"]],
    ["/tmp/wrapper ls", ["executable:/tmp/wrapper:/tmp/wrapper"]],
    ["/usr/bin/env ls", ["executable:/usr/bin/env:/usr/bin/env"]],
    ["/tmp/env ls", ["executable:/tmp/env:/tmp/env"]],
    ["env /tmp/nice ls", ["executable:/tmp/nice:/tmp/nice"]],
    [
      "/usr/bin/env /tmp/nice /bin/ls",
      [
        "executable:/usr/bin/env:/usr/bin/env",
        "executable:/tmp/nice:/tmp/nice",
        "executable:/bin/ls:/bin/ls",
      ],
    ],
    [
      "/tmp/env /tmp/env /bin/ls",
      [
        "executable:/tmp/env:/tmp/env",
        "executable:/tmp/env:/tmp/env",
        "executable:/bin/ls:/bin/ls",
      ],
    ],
  ])("emits every slash-containing executable token once in source order: %s", async (command, expected) => {
    // Given a direct executable or a normalized wrapper chain.
    // When references are collected from the authoritative invocation.
    // Then each distinct executable-token position is represented once in source order.
    expect(await referenceValues(command)).toEqual(expected);
  });

  test("preserves wrapper executable reference metadata", async () => {
    // Given a wrapper chain in the second top-level segment with quoted spelling.
    const command = "true; /usr/bin/env '/tmp/nice' /bin/ls";

    // When the authoritative shell analysis collects executable references.
    const references = (await analyzeShell(command, "/workspace")).staticFileReferences;

    // Then raw spelling, cooked value, source order, segment, and cwd remain attributable.
    expect(references).toEqual([
      { kind: "executable", raw: "/usr/bin/env", value: "/usr/bin/env", topLevelSegment: 1, cwd: "/workspace" },
      { kind: "executable", raw: "'/tmp/nice'", value: "/tmp/nice", topLevelSegment: 1, cwd: "/workspace" },
      { kind: "executable", raw: "/bin/ls", value: "/bin/ls", topLevelSegment: 1, cwd: "/workspace" },
    ]);
  });

  test.each([
    ["command source /tmp/source-file", "source:/tmp/source-file:/tmp/source-file"],
    ["command -- source '/tmp/source file'", "source:'/tmp/source file':/tmp/source file"],
    ["command -p source /tmp/source-file", "source:/tmp/source-file:/tmp/source-file"],
    ["command \"source\" '/tmp/source file'", "source:'/tmp/source file':/tmp/source file"],
    ["builtin source /tmp/source-file", "source:/tmp/source-file:/tmp/source-file"],
    ["builtin \"source\" '/tmp/source file'", "source:'/tmp/source file':/tmp/source file"],
    ["builtin . \"/tmp/profile\"", "source:\"/tmp/profile\":/tmp/profile"],
  ])("emits a wrapped source operand from its effective invocation: %s", async (command, expected) => {
    // Given a supported command/builtin dispatch to source or dot.
    // When the effective operand is collected from the authoritative invocation.
    // Then its exact raw and cooked spelling are emitted as a source reference.
    expect(await referenceValues(command)).toEqual([expected]);
  });

  test.each([
    "cat arbitrary/path",
    "echo value > /tmp/output",
    "cat 1< /tmp/input",
    "cat 2< /tmp/input",
    "cat 00< /tmp/input",
    "bash -x script.sh",
    "bash --rcfile rc script.sh",
    "bash --init-file rc script.sh",
    "bash -O extglob script.sh",
    "bash +O extglob script.sh",
    "sh +x script.sh",
    "zsh +x script.zsh",
    "bash --rcfile=rc script.sh",
    "bash --init-file=rc script.sh",
    "bash --unknown=value script.sh",
    "bash $script",
    "bash ${script}",
    "bash $(find-script)",
    "bash $((1 + 1))",
    "bash <(find-script)",
    "bash {one,two}.sh",
    "bash $'script.sh'",
    "bash *.sh",
    "bash ~/script.sh",
    "source -p ./profile",
    "source $profile",
    "command source -p /tmp/source-file",
    "builtin source -p /tmp/source-file",
    "command source $profile",
    "env source /tmp/not-a-source-operand",
    "builtin /tmp/not-a-builtin",
    "busybox /tmp/not-an-applet",
    "builtin ls /tmp/not-an-executable",
    "busybox echo /tmp/not-an-executable",
    "sudo -v /tmp/not-an-executable",
    "sudo --validate /tmp/not-an-executable",
    "sudo -l /tmp/not-an-executable",
    "sudo --list /tmp/not-an-executable",
    "sudo -e /tmp/not-an-executable",
    "sudo --edit /tmp/not-an-executable",
    "sudo --definitely-unknown /tmp/not-an-executable",
    "sudo -- -v /tmp/not-an-executable",
    "nice -n bogus /tmp/not-an-executable",
    "nice --adjustment=bogus /tmp/not-an-executable",
    "env -C $dir /tmp/not-an-executable",
    "env -C\"$dir\" /tmp/not-an-executable",
    "sudo -D $dir /tmp/not-an-executable",
    "sudo --chdir=\"$dir\" /tmp/not-an-executable",
    "sh -c './nested-tool'",
  ])("does not guess an ambiguous operand: %s", async (command) => {
    // Given an option, non-operand, expansion, glob, tilde, or nested shell string.
    // When static file references are requested.
    // Then the analyzer emits no reference for the ambiguous value.
    expect(await referenceValues(command)).toEqual([]);
  });

  test.each([
    ["(cat; true) < /tmp/input", [{ value: "/tmp/input", topLevelSegment: 0 }]],
    ["(cat | true) < /tmp/input", [{ value: "/tmp/input", topLevelSegment: 0 }]],
    ["cat; true < /tmp/input", [{ value: "/tmp/input", topLevelSegment: 1 }]],
    [
      "cat < /tmp/one; true < /tmp/two",
      [{ value: "/tmp/one", topLevelSegment: 0 }, { value: "/tmp/two", topLevelSegment: 1 }],
    ],
  ])("owns each syntactic input redirect exactly once: %s", async (command, expected) => {
    // Given standalone or compound input-redirection syntax.
    const analysis = await analyzeShell(command, "/workspace");

    // When typed input references are projected with their owning segment.
    const inputs = analysis.staticFileReferences
      .filter((reference) => reference.kind === "input_redirect")
      .map((reference) => ({ value: reference.value, topLevelSegment: reference.topLevelSegment }));

    // Then each redirect target has one deterministic top-level segment owner.
    expect(inputs).toEqual(expected);
  });

  test.each([
    ["{ f() { cat; }; true; } < /tmp/input", { value: "/tmp/input", topLevelSegment: 1, cwd: "/workspace" }],
    ["{ f() { cat; }; g() { cat; }; VALUE=1; true; } 0< ./input", { value: "./input", topLevelSegment: 2, cwd: "/workspace" }],
    ["(f() { cat; }; true) < ./input", { value: "./input", topLevelSegment: 1, cwd: "/workspace" }],
  ])("lets an executed command own an enclosing redirect after non-emitting nodes: %s", async (command, expected) => {
    // Given an enclosing input redirect preceded by function bodies or other non-emitting syntax.
    const analysis = await analyzeShell(command, "/workspace");

    // When typed input references are collected.
    const inputs = analysis.staticFileReferences
      .filter((reference) => reference.kind === "input_redirect")
      .map(({ value, topLevelSegment, cwd }) => ({ value, topLevelSegment, cwd }));

    // Then a real executed command claims the redirect exactly once; function bodies cannot consume it.
    expect(inputs).toEqual([expected]);
  });

  test.each([
    ["< /tmp/plain-input", { value: "/tmp/plain-input", topLevelSegment: 0, cwd: "/workspace" }],
    ["0< './plain input'", { value: "./plain input", topLevelSegment: 0, cwd: "/workspace" }],
    ["ROUND9=value < /tmp/assignment-input", { value: "/tmp/assignment-input", topLevelSegment: 0, cwd: "/workspace" }],
    ["{ f() { cat; }; } < /tmp/function-input", { value: "/tmp/function-input", topLevelSegment: 0, cwd: "/workspace" }],
  ])("emits an executed input redirect without an ordinary command owner: %s", async (command, expected) => {
    // Given input-only, assignment-only, or function-definition-only executed syntax.
    const analysis = await analyzeShell(command, "/workspace");

    // When static input references are collected directly from the existing AST redirect node.
    const inputs = analysis.staticFileReferences
      .filter((reference) => reference.kind === "input_redirect")
      .map(({ value, topLevelSegment, cwd }) => ({ value, topLevelSegment, cwd }));

    // Then the shell-opened input target is emitted exactly once with deterministic ownership metadata.
    expect(inputs).toEqual([expected]);
  });

  test.each([
    "> /tmp/output",
    "2< /tmp/not-stdin",
    "< $dynamic",
    "{ f() { cat; }; } > /tmp/output",
  ])("does not promote a non-input or dynamic commandless redirect: %s", async (command) => {
    // Given output, non-stdin descriptor, or dynamic redirect-only syntax.
    // When static file references are collected.
    // Then no unsupported target is promoted to reviewer-readable evidence.
    expect((await analyzeShell(command, "/workspace")).staticFileReferences).toEqual([]);
  });

  test.each([
    [
      "env -C /tmp sh ./script.sh < ./input",
      [
        { kind: "shell_script", value: "./script.sh", cwd: "/tmp" },
        { kind: "input_redirect", value: "./input", cwd: "/workspace" },
      ],
    ],
    [
      "sudo -D relative sh ./script.sh < ./input",
      [
        { kind: "shell_script", value: "./script.sh", cwd: "/workspace/relative" },
        { kind: "input_redirect", value: "./input", cwd: "/workspace" },
      ],
    ],
  ])("attributes process operands and shell redirects to their actual cwd: %s", async (command, expected) => {
    // Given a wrapper chdir around a shell script plus a parent-shell input redirect.
    const analysis = await analyzeShell(command, "/workspace");

    // When static evidence is projected by kind and resolution directory.
    const references = analysis.staticFileReferences.map(({ kind, value, cwd }) => ({ kind, value, cwd }));

    // Then process operands use execution cwd while the shell-opened redirect uses parent cwd.
    expect<unknown>(references).toEqual(expected);
  });

});
