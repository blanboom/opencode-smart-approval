import { describe, expect, test } from "bun:test";
import { pipelineFixture, runCommand } from "./fixtures/decision-pipeline-fixture";

describe("approval decision pipeline", () => {
  test.each([
    ["enabled by default", undefined, 1],
    ["disabled by policy", false, 0],
  ] as const)("keeps review session cleanup %s", async (_label, cleanupSession, expectedCleanups) => {
    // Given a v3 cleanup policy and one command requiring review.
    const fixture = pipelineFixture({ ...(cleanupSession === undefined ? {} : { cleanupSession }) });
    try {
      // When the reviewer completes successfully.
      await expect(runCommand(fixture, "scanner-allow")).resolves.toBeUndefined();

      // Then the policy choice controls normal child-session deletion.
      expect(fixture.cleanupCount()).toBe(expectedCleanups);
    } finally {
      fixture.cleanup();
    }
  });

  test("lets a user allow bypass a scanner block and the OpenCode reviewer", async () => {
    // Given an explicit user allow for a command the scanner would block.
    const fixture = pipelineFixture({
      allow: [{ match: "^scanner-block(?:\\s|$).*", scope: "segment", priority: 100 }],
    });
    try {
      // When the command is evaluated.
      const action = runCommand(fixture, "scanner-block");

      // Then the user rule is terminal and no later stage runs.
      await expect(action).resolves.toBeUndefined();
      expect(fixture.scans()).toEqual([]);
      expect(fixture.reviewCount()).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  test("lets a user deny bypass the scanner and OpenCode reviewer", async () => {
    // Given an explicit user deny rule.
    const fixture = pipelineFixture({
      deny: [{ match: "^scanner-allow(?:\\s|$).*", scope: "segment", priority: 100 }],
    });
    try {
      // When the denied command is evaluated.
      const action = runCommand(fixture, "scanner-allow");

      // Then it is rejected by the user-rule stage alone.
      await expect(action).rejects.toMatchObject({
        name: "CommandApprovalError",
        verdict: { source: "rule" },
      });
      expect(fixture.scans()).toEqual([]);
      expect(fixture.reviewCount()).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  test("lets a constrained non-output builtin allow bypass the scanner and OpenCode reviewer", async () => {
    // Given no matching user rule and a constrained shell predicate.
    const fixture = pipelineFixture({});
    try {
      // When the builtin command is evaluated.
      const action = runCommand(fixture, "test -n value");

      // Then the builtin stage is terminal.
      await expect(action).resolves.toBeUndefined();
      expect(fixture.scans()).toEqual([]);
      expect(fixture.reviewCount()).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  test("routes output-capable commands through Tirith and the reviewer", async () => {
    // Given output commands spanning plain, escaped, dynamic, path, and wrapper forms.
    const fixture = pipelineFixture({});
    const commands = [
      "echo harmless",
      String.raw`echo -e '\033]52;c;Y2xpcGJvYXJk\a'`,
      "printf '%s' harmless",
      String.raw`printf '%b' '\033]8;;https://example.invalid\033\\label\033]8;;\033\\'`,
      `printf '\u001B]52;c;Y2xpcGJvYXJk\u0007'`,
      'echo "$(id)"',
      "printf '%s' \"$HOME\"",
      "echo '",
      String.raw`printf '%b' '\x'`,
      'echo "$(',
      "/bin/echo harmless",
      "/usr/bin/printf '%s' harmless",
      "command echo harmless",
      "builtin printf '%s' harmless",
      "env /usr/bin/printf '%s' harmless",
      "busybox echo harmless",
    ];
    try {
      // When the exported hook evaluates source text without executing any analyzed command.
      await Promise.all(commands.map((command) => runCommand(fixture, command)));

      // Then every command is scanned and reviewed instead of terminal-allowed.
      expect([...fixture.scans()].sort()).toEqual([...commands].sort());
      expect(fixture.reviewCount()).toBe(commands.length);
    } finally {
      fixture.cleanup();
    }
  });

  test("routes modified executable identity through scanner and reviewer", async () => {
    // Given commands that previously inherited the effective ls builtin allow.
    const fixture = pipelineFixture({});
    const commands = [
      "PATH=./untrusted ls",
      "env PATH=./untrusted ls",
      "LD_PRELOAD=./evil.so /bin/ls",
      "command ls",
      "exec ls",
      "env ls",
      "nice -n 5 ls",
      "nohup ls",
      "time -o /tmp/time.log ls",
      "builtin ls",
      "busybox ls",
      "sudo ls",
    ];
    try {
      // When the real hook evaluates each modified invocation.
      await Promise.all(commands.map((command) => runCommand(fixture, command)));

      // Then none terminal-allow before the scanner and reviewer stages.
      expect([...fixture.scans()].sort()).toEqual([...commands].sort());
      expect(fixture.reviewCount()).toBe(commands.length);
    } finally {
      fixture.cleanup();
    }
  });

  test("runs the scanner before the OpenCode reviewer when deterministic rules do not match", async () => {
    // Given a command outside both deterministic rule stages.
    const fixture = pipelineFixture({});
    try {
      // When the scanner allows it and contextual judgment is still needed.
      const action = runCommand(fixture, "scanner-allow");

      // Then scanner evidence exists before the only OpenCode reviewer call.
      await expect(action).resolves.toBeUndefined();
      expect(fixture.scans()).toEqual(["scanner-allow"]);
      expect(fixture.reviewCount()).toBe(1);
      expect(fixture.reviewerObservedScan()).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test("keeps pipeline segmentation and does not let one allowed segment authorize its sibling", async () => {
    // Given a user rule that allows only the left side of a pipeline.
    const fixture = pipelineFixture({
      allow: [{ match: "^trusted-left(?:\\s|$).*", scope: "segment", priority: 100 }],
    });
    try {
      // When the right side remains unmatched.
      const action = runCommand(fixture, "trusted-left | scanner-allow");

      // Then the complete raw pipeline still reaches scanner and OpenCode reviewer.
      await expect(action).resolves.toBeUndefined();
      expect(fixture.scans()).toEqual(["trusted-left | scanner-allow"]);
      expect(fixture.reviewCount()).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });

  test("short-circuits a pipeline only when every segment is explicitly allowed", async () => {
    // Given user rules that cover both static pipeline segments.
    const fixture = pipelineFixture({
      allow: [{ match: "^trusted-(?:left|right)(?:\\s|$).*", scope: "segment", priority: 100 }],
    });
    try {
      // When both sides are user-allowed.
      const action = runCommand(fixture, "trusted-left | trusted-right");

      // Then the whole pipeline is allowed without later stages.
      await expect(action).resolves.toBeUndefined();
      expect(fixture.scans()).toEqual([]);
      expect(fixture.reviewCount()).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });
});
