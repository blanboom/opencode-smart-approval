import { describe, expect, test } from "bun:test";
import { compileRule } from "../src/rule-compiler";
import { evaluateRules } from "../src/rules";

const exactPattern = (command: string): string => `^${command.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`;

describe("builtin approval rules", () => {
  test("retains an exact full-command user allow for a modified invocation", async () => {
    // Given an explicit command-scope rule bound to the complete modified command.
    const command = "PATH=./untrusted ls";
    const rule = compileRule({
      label: "user.allow[0]",
      match: "^PATH=\\./untrusted ls$",
      decision: "allow",
      scope: "command",
      origin: "user",
    });

    // When the complete command rule is evaluated alongside identity analysis.
    const evaluation = await evaluateRules([rule], { command });

    // Then explicit full-command policy remains terminal despite segment ineligibility.
    expect(evaluation.decision).toBe("allow");
    expect(evaluation.matchedRules.map((matched) => matched.label)).toEqual(["user.allow[0]"]);
  });

  test.each(["exec ls", "builtin ls", "busybox ls", "env --unknown /bin/ls"])(
    "lets only an exact command rule override wrapper identity review: %s",
    async (command) => {
      // Given exact and partial command-scope allows for an identity-modifying wrapper.
      const exact = compileRule({
        label: "user.allow.exact-wrapper",
        match: exactPattern(command),
        decision: "allow",
        scope: "command",
        origin: "user",
      });
      const partial = compileRule({
        label: "user.allow.partial-wrapper",
        match: command.split(" ").at(-1) ?? command,
        decision: "allow",
        scope: "command",
        origin: "user",
      });

      // When each rule is evaluated independently.
      const [exactEvaluation, partialEvaluation] = await Promise.all([
        evaluateRules([exact], { command }),
        evaluateRules([partial], { command }),
      ]);

      // Then only complete explicit authorization suppresses identity-only review issues.
      expect(exactEvaluation.decision).toBe("allow");
      expect(partialEvaluation.decision).toBe("review");
    },
  );

  test.each(["echo '", "echo $(id)"])("does not let an exact rule override unsafe shell analysis: %s", async (command) => {
    // Given an exact command rule covering malformed or dynamic shell syntax.
    const rule = compileRule({
      label: "user.allow.unsafe-shell",
      match: exactPattern(command),
      decision: "allow",
      scope: "command",
      origin: "user",
    });

    // When the unsafe command is evaluated.
    const evaluation = await evaluateRules([rule], { command });

    // Then non-identity parser issues remain fail-closed.
    expect(evaluation.decision).toBe("review");
  });

  test.each([
    ["bare effective executable", "ls"],
    ["command prefix", "^PATH=\\./untrusted ls"],
    ["command suffix", "PATH=\\./untrusted ls$"],
    ["anchor-shaped alternation", "^PATH=\\./untrusted|ls$"],
    ["anchor-shaped lookahead", "^PATH=\\./untrusted(?= ls)|never$"],
  ])("rejects a partial command allow for one modified invocation: %s", async (_name, match) => {
    // Given a command-scope allow that matches only part of a terminal-ineligible command.
    const rule = compileRule({
      label: "user.allow.partial",
      match,
      decision: "allow",
      scope: "command",
      origin: "user",
    });

    // When the modified invocation is evaluated.
    const evaluation = await evaluateRules([rule], { command: "PATH=./untrusted ls" });

    // Then only an exact full-command rule may override the identity protection.
    expect(evaluation.decision).toBe("review");
    expect(evaluation.matchedRules).toEqual([]);
  });

  test("retains command-scope matching behavior for an eligible single invocation", async () => {
    // Given a non-anchored command rule and a terminal-eligible ordinary invocation.
    const rule = compileRule({
      label: "user.allow.ordinary",
      match: "ls",
      decision: "allow",
      scope: "command",
      origin: "user",
    });

    // When the ordinary invocation is evaluated.
    const evaluation = await evaluateRules([rule], { command: "ls -la" });

    // Then existing command-scope rule semantics remain available for eligible commands.
    expect(evaluation.decision).toBe("allow");
    expect(evaluation.matchedRules.map((matched) => matched.label)).toEqual(["user.allow.ordinary"]);
  });

  test.each([
    ["PATH=./untrusted ls; true", "^PATH=\\./untrusted ls; true$"],
    ["PATH=./untrusted ls && true", "^PATH=\\./untrusted ls && true$"],
  ])("retains an anchored full-command allow across connectors: %s", async (command, match) => {
    // Given an anchored command-scope rule covering every executable segment and connector.
    const rule = compileRule({
      label: "user.allow.compound",
      match,
      decision: "allow",
      scope: "command",
      origin: "user",
    });

    // When the compound command is evaluated against segment identity protections.
    const evaluation = await evaluateRules([rule], { command });

    // Then the explicit complete-command authorization remains terminal.
    expect(evaluation.decision).toBe("allow");
    expect(evaluation.matchedRules.map((matched) => matched.label)).toEqual(["user.allow.compound"]);
  });

  test("does not treat a non-anchored command rule as a compound override", async () => {
    // Given a command-scope allow that matches only a prefix of a compound command.
    const command = "PATH=./untrusted ls; true";
    const rule = compileRule({
      label: "user.allow.prefix",
      match: "PATH=\\./untrusted ls",
      decision: "allow",
      scope: "command",
      origin: "user",
    });

    // When the unmatched sibling segment is evaluated.
    const evaluation = await evaluateRules([rule], { command });

    // Then the prefix rule cannot authorize the complete compound command.
    expect(evaluation.decision).toBe("review");
    expect(evaluation.matchedRules).toEqual([]);
  });

  test.each([
    ["alternation escapes the anchors", "PATH=./untrusted ls; true", "^PATH=\\./untrusted ls|true$"],
    ["lookahead escapes the anchors", "PATH=./untrusted ls; true", "^PATH=\\./untrusted ls(?=;)|never$"],
  ])("requires an anchored rule to consume the complete command: %s", async (_name, command, match) => {
    // Given anchor-shaped regex text whose actual match consumes less than the command.
    const rule = compileRule({
      label: "user.allow.partial",
      match,
      decision: "allow",
      scope: "command",
      origin: "user",
    });

    // When the compound command is evaluated.
    const evaluation = await evaluateRules([rule], { command });

    // Then source-text anchors alone cannot grant complete-command authorization.
    expect(evaluation.decision).toBe("review");
    expect(evaluation.matchedRules).toEqual([]);
  });
});
