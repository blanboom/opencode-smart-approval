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

  test("preserves original and effective executable identity through modifiers", async () => {
    // Given a nested wrapper chain that also changes executable lookup.
    const analysis = await analyzeShell("env PATH=./untrusted nice -n 5 /bin/ls", "/workspace");

    // When the shell command is reduced to its effective invocation.
    const segment = analysis.segments[0];

    // Then both identities, every wrapper, and the execution assignment remain explicit.
    expect(segment).toMatchObject({
      originalExecutable: { raw: "env", value: "env", expansionFree: true },
      effectiveExecutable: { raw: "/bin/ls", value: "/bin/ls", expansionFree: true },
      wrapperChain: [
        { executable: { value: "env" } },
        { executable: { value: "nice" } },
      ],
      assignments: [{ name: "PATH", value: "./untrusted", raw: "PATH=./untrusted", source: "env" }],
      terminalAllowEligible: false,
      connector: "start",
      topLevel: true,
      subshellDepth: 0,
    });
  });

  test.each([
    ["command -- /bin/ls", ["command"], "/bin/ls"],
    ["command -p /bin/ls", ["command"], "/bin/ls"],
    ["env -C /tmp /bin/ls", ["env"], "/bin/ls"],
    ["env -C/tmp /bin/ls", ["env"], "/bin/ls"],
    ["env --chdir /tmp /bin/ls", ["env"], "/bin/ls"],
    ["env --chdir=/tmp /bin/ls", ["env"], "/bin/ls"],
    ["nice -n5 /bin/ls", ["nice"], "/bin/ls"],
    ["nice -n 5 /bin/ls", ["nice"], "/bin/ls"],
    ["nice --adjustment 5 /bin/ls", ["nice"], "/bin/ls"],
    ["nice --adjustment=5 /bin/ls", ["nice"], "/bin/ls"],
  ])("resolves supported value-consuming and attached wrapper options: %s", async (command, wrappers, effective) => {
    // Given a recognized wrapper with a statically resolvable option form.
    const analysis = await analyzeShell(command);

    // When its effective invocation is reduced.
    const segment = analysis.segments[0];

    // Then wrapper identity and the true executable remain explicit and ineligible for segment allow.
    expect(segment?.wrapperChain.map((wrapper) => wrapper.executable.value)).toEqual(wrappers);
    expect(segment?.effectiveExecutable.value).toBe(effective);
    expect(segment?.terminalAllowEligible).toBe(false);
    expect(analysis.issues).toEqual([]);
  });

  test.each([
    ["env -- -u NAME /tmp/not-executable", "-u"],
    ["env -i -- --unset=NAME /tmp/not-executable", "--unset=NAME"],
    ["exec -- -a argv0 /tmp/not-executable", "-a"],
    ["exec -c -- -a argv0 /tmp/not-executable", "-a"],
    ["nice -- -n 5 /tmp/not-executable", "-n"],
    ["nice -n 1 -- -5 /tmp/not-executable", "-5"],
    ["/usr/bin/time -- -o /tmp/time-output /tmp/not-executable", "-o"],
    ["/usr/bin/time -p -- --output=/tmp/time-output /tmp/not-executable", "--output=/tmp/time-output"],
    ["env -- -- /tmp/not-executable", "--"],
    ["exec -- -- /tmp/not-executable", "--"],
    ["nice -- -- /tmp/not-executable", "--"],
    ["time -- -- /tmp/not-executable", "--"],
  ])("stops wrapper option parsing at the first standalone separator: %s", async (command, effective) => {
    // Given a wrapper separator followed by an option-looking utility or repeated separator.
    const analysis = await analyzeShell(command, "/workspace");

    // When the authoritative invocation is reduced once.
    const segment = analysis.segments[0];

    // Then the immediate post-separator word is the utility and later paths are not leased.
    expect(segment?.effectiveExecutable.value).toBe(effective);
    expect(segment?.targetKind).toBe("external");
    expect(segment?.terminalAllowEligible).toBe(false);
    expect(analysis.staticFileReferences.map((reference) => reference.value)).not.toContain("/tmp/not-executable");
  });

  test.each(["env", "exec", "nice", "/usr/bin/time"])(
    "retains a slash-containing utility immediately after a %s separator",
    async (wrapper) => {
      // Given a wrapper separator followed by a static utility and arbitrary operand.
      const analysis = await analyzeShell(`${wrapper} -- /tmp/tool /tmp/operand`, "/workspace");

      // When effective identity and executable references are inspected.
      const segment = analysis.segments[0];

      // Then only the immediate executable token is leased.
      expect(segment?.effectiveExecutable.value).toBe("/tmp/tool");
      expect(analysis.staticFileReferences.map((reference) => reference.value)).toEqual([
        ...(wrapper.includes("/") ? [wrapper] : []),
        "/tmp/tool",
      ]);
    },
  );

  test.each([
    ["env -C /tmp ./tool", "/tmp"],
    ["env -C/tmp ./tool", "/tmp"],
    ["env --chdir /tmp ./tool", "/tmp"],
    ["env --chdir=/tmp ./tool", "/tmp"],
    ["sudo -D /tmp ./tool", "/tmp"],
    ["sudo -D/tmp ./tool", "/tmp"],
    ["sudo --chdir /tmp ./tool", "/tmp"],
    ["sudo --chdir=/tmp ./tool", "/tmp"],
    ["env -C relative ./tool", "/workspace/relative"],
    ["sudo -D relative ./tool", "/workspace/relative"],
    ["env -C /tmp -- ./tool", "/tmp"],
    ["sudo -D /tmp -- ./tool", "/tmp"],
  ])("retains the wrapper-adjusted execution cwd: %s", async (command, executionCwd) => {
    // Given a static absolute or relative wrapper chdir option.
    const analysis = await analyzeShell(command, "/workspace");

    // When invocation identity and executable evidence are inspected.
    const segment = analysis.segments[0];
    const executable = analysis.staticFileReferences.find((reference) => reference.kind === "executable");

    // Then both the typed invocation and target reference resolve from the changed directory.
    expect(segment).toMatchObject({ targetKind: "external", executionCwd });
    expect(executable).toMatchObject({ value: "./tool", cwd: executionCwd });
  });

});
