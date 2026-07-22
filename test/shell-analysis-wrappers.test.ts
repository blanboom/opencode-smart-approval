import { describe, expect, test } from "bun:test";
import { analyzeShell } from "../src/shell-analysis";

describe("Tree-sitter shell analysis", () => {
  test("retains cwd at each level of nested chdir wrappers", async () => {
    // Given two wrappers whose relative directory changes compose in source order.
    const analysis = await analyzeShell("env -C /tmp /usr/bin/env -C relative ./tool", "/workspace");

    // When wrapper and final target execution directories are inspected.
    const segment = analysis.segments[0];

    // Then each executable token is attributed to the directory in which that token runs.
    expect(segment?.wrapperChain.map((wrapper) => [wrapper.executable.value, wrapper.executionCwd])).toEqual([
      ["env", "/workspace"],
      ["/usr/bin/env", "/tmp"],
    ]);
    expect(segment?.executionCwd).toBe("/tmp/relative");
    expect(analysis.staticFileReferences).toEqual([
      { kind: "executable", raw: "/usr/bin/env", value: "/usr/bin/env", topLevelSegment: 0, cwd: "/tmp" },
      { kind: "executable", raw: "./tool", value: "./tool", topLevelSegment: 0, cwd: "/tmp/relative" },
    ]);
  });

  test.each([
    "sudo /bin/ls",
    "sudo -n /bin/ls",
    "sudo -nE /bin/ls",
    "sudo --non-interactive /bin/ls",
    "sudo -u root /bin/ls",
    "sudo --user=root /bin/ls",
    "sudo -- /bin/ls",
  ])("resolves only allowlisted sudo execution grammar: %s", async (command) => {
    // Given an allowlisted sudo execution form.
    const analysis = await analyzeShell(command, "/workspace");

    // When its wrapper identity and target are inspected.
    const segment = analysis.segments[0];

    // Then the external command is proven without making the wrapper terminal-eligible.
    expect(segment?.wrapperChain.map((wrapper) => wrapper.executable.value)).toEqual(["sudo"]);
    expect(segment?.effectiveExecutable.value).toBe("/bin/ls");
    expect(segment?.terminalAllowEligible).toBe(false);
    expect(analysis.staticFileReferences.map((reference) => reference.value)).toEqual(["/bin/ls"]);
  });

  test.each([
    "sudo -v /tmp/not-an-executable",
    "sudo --validate /tmp/not-an-executable",
    "sudo -l /tmp/not-an-executable",
    "sudo --list /tmp/not-an-executable",
    "sudo -e /tmp/not-an-executable",
    "sudo --edit /tmp/not-an-executable",
    "sudo -nv /tmp/not-an-executable",
    "sudo -nl /tmp/not-an-executable",
    "sudo --definitely-unknown /tmp/not-an-executable",
    "sudo $option /tmp/not-an-executable",
  ])("does not guess an executable for a sudo mode or unknown option: %s", async (command) => {
    // Given a non-execution mode, unknown option, or dynamic option.
    const analysis = await analyzeShell(command, "/workspace");

    // When the authoritative invocation and references are inspected.
    const segment = analysis.segments[0];

    // Then the form fails closed without promoting a later path-like argument.
    expect(segment?.terminalAllowEligible).toBe(false);
    expect(analysis.staticFileReferences.map((reference) => reference.value)).not.toContain("/tmp/not-an-executable");
    expect(analysis.issues.length).toBeGreaterThan(0);
  });

  test.each([
    "nice -n bogus /tmp/not-an-executable",
    "nice --adjustment bogus /tmp/not-an-executable",
    "nice --adjustment=bogus /tmp/not-an-executable",
    "nice -nbogus /tmp/not-an-executable",
  ])("rejects an invalid nice adjustment without guessing a target: %s", async (command) => {
    // Given a nice adjustment that is not a static integer.
    const analysis = await analyzeShell(command, "/workspace");

    // When wrapper eligibility and references are inspected.
    const segment = analysis.segments[0];

    // Then the later path is not a proven executable token.
    expect(segment?.terminalAllowEligible).toBe(false);
    expect(analysis.staticFileReferences.map((reference) => reference.value)).not.toContain("/tmp/not-an-executable");
    expect(analysis.issues).toContainEqual(expect.objectContaining({ kind: "identity" }));
  });

  test.each([
    "builtin /tmp/not-a-builtin",
    "busybox /tmp/not-an-applet",
    "builtin ls /tmp/not-an-executable",
    "busybox echo /tmp/not-an-executable",
  ])("does not infer an external target from unsupported builtin dispatch: %s", async (command) => {
    // Given a builtin or applet form outside the supported dispatch grammar.
    const analysis = await analyzeShell(command, "/workspace");

    // When effective identity and references are inspected.
    const segment = analysis.segments[0];

    // Then the wrapper remains identity-ineligible and no argument is leased as executable.
    expect(segment?.terminalAllowEligible).toBe(false);
    expect(analysis.staticFileReferences.map((reference) => reference.value)).not.toContain("/tmp/not-an-executable");
    expect(analysis.issues).toContainEqual(expect.objectContaining({ kind: "identity" }));
  });

  test.each([
    "command --unknown /bin/ls",
    "command --unknown -v /bin/ls",
    "env --unknown /bin/ls",
    "nice --unknown /bin/ls",
    "nohup --unknown /bin/ls",
    "time --unknown /bin/ls",
    "exec --unknown /bin/ls",
    "builtin",
    "busybox",
    "sudo",
  ])("fails closed for a recognized but unresolved wrapper: %s", async (command) => {
    // Given a recognized wrapper whose target cannot be resolved safely.
    const analysis = await analyzeShell(command);

    // When terminal eligibility and typed issues are inspected.
    const segment = analysis.segments[0];

    // Then it is identity-ineligible instead of masquerading as an ordinary executable.
    expect(segment?.terminalAllowEligible).toBe(false);
    expect(analysis.issues).toContainEqual(expect.objectContaining({ kind: "identity" }));
  });

  test.each([8, 9, 64])("retains the effective executable through %i wrappers", async (depth) => {
    // Given a bounded source containing a deep recognized wrapper chain.
    const command = [...Array.from({ length: depth }, () => "/tmp/env"), "/bin/ls"].join(" ");

    // When the one authoritative invocation is reduced.
    const analysis = await analyzeShell(command, "/workspace");

    // Then no finite reducer cutoff loses identity or slash-containing executable references.
    expect(analysis.segments[0]?.wrapperChain).toHaveLength(depth);
    expect(analysis.segments[0]?.effectiveExecutable.value).toBe("/bin/ls");
    expect(analysis.staticFileReferences.map((reference) => reference.value)).toEqual([
      ...Array.from({ length: depth }, () => "/tmp/env"),
      "/bin/ls",
    ]);
  });

  test.each([
    ["/usr/bin/time -o command-approval.jsonc /bin/cat /tmp/input", ["-o", "command-approval.jsonc"]],
    ["/usr/bin/time -ocommand-approval.jsonc /bin/cat /tmp/input", ["-ocommand-approval.jsonc"]],
    ["/usr/bin/time --output command-approval.jsonc /bin/cat /tmp/input", ["--output", "command-approval.jsonc"]],
    ["/usr/bin/time --output=command-approval.jsonc /bin/cat /tmp/input", ["--output=command-approval.jsonc"]],
  ])("retains external time output options before reducing its target: %s", async (command, wrapperArguments) => {
    // Given an external time wrapper with a statically named output file.
    const analysis = await analyzeShell(command, "/workspace");

    // When wrapper side effects and the effective executable are inspected.
    const segment = analysis.segments[0];

    // Then output arguments remain available to mutation analysis after target reduction.
    expect(segment?.wrapperChain[0]?.arguments.map((argument) => argument.value)).toEqual(wrapperArguments);
    expect(segment?.effectiveExecutable.value).toBe("/bin/cat");
  });

});
