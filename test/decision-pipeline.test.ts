import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createHook } from "../src/index";

type RuleLists = {
  readonly allow?: readonly unknown[];
  readonly deny?: readonly unknown[];
  readonly review?: readonly unknown[];
};

type PipelineFixture = {
  readonly hook: ReturnType<typeof createHook>;
  readonly scans: () => readonly string[];
  readonly reviewCount: () => number;
  readonly reviewerObservedScan: () => boolean;
  readonly cleanup: () => void;
};

const pipelineFixture = (rules: RuleLists): PipelineFixture => {
  const root = mkdtempSync(join(tmpdir(), "approval-pipeline-"));
  const xdg = join(root, "xdg");
  const directory = join(root, "project");
  const configDirectory = join(xdg, "opencode");
  const capturePath = join(root, "scans.txt");
  const tirithPath = join(root, "fake-tirith");
  mkdirSync(configDirectory, { recursive: true });
  mkdirSync(directory, { recursive: true });
  writeFileSync(tirithPath, [
    "#!/bin/sh",
    "for argument do command=$argument; done",
    `printf '%s\\n' "$command" >> '${capturePath}'`,
    "printf '%s\\n' '{\"summary\":\"fake scan\",\"findings\":[]}'",
    "case $command in",
    "  *scanner-block*) exit 1 ;;",
    "  *) exit 0 ;;",
    "esac",
  ].join("\n"));
  chmodSync(tirithPath, 0o755);

  let reviews = 0;
  let scanObserved = false;
  const reviewer = Bun.serve({
    port: 0,
    fetch: () => {
      reviews += 1;
      scanObserved = existsSync(capturePath) && readFileSync(capturePath, "utf8").trim().length > 0;
      return Response.json({
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({
              outcome: "allow",
              risk_level: "medium",
              user_authorization: "unknown",
              categories: [{ id: "security.test", score: 0.2 }],
              reasons: ["fake reviewer approval"],
            }),
          },
          finish_reason: "stop",
          index: 0,
        }],
        created: 0,
        id: "fake-review",
        model: "fake-model",
        object: "chat.completion",
        usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
      });
    },
  });

  writeFileSync(join(configDirectory, "command-approval.jsonc"), JSON.stringify({
    version: 2,
    self_protection: { enabled: true },
    review: {
      base_url: `${reviewer.url.origin}/v1`,
      api_key: "test-key",
      model: "fake-model",
      max_retries: 0,
      context_messages: 0,
    },
    tirith: { enabled: true, path: tirithPath, timeout_ms: 5_000, fail_open: false },
    rules: {
      allow: rules.allow ?? [],
      deny: rules.deny ?? [],
      block: [],
      review: rules.review ?? [],
    },
  }));

  const previousXdg = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = xdg;
  const hook = createHook(directory);
  if (previousXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = previousXdg;

  return {
    hook,
    scans: () => existsSync(capturePath)
      ? readFileSync(capturePath, "utf8").trim().split("\n").filter(Boolean)
      : [],
    reviewCount: () => reviews,
    reviewerObservedScan: () => scanObserved,
    cleanup: () => {
      reviewer.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
};

const runCommand = (fixture: PipelineFixture, command: string): Promise<void> => fixture.hook(
  { tool: "bash", sessionID: "pipeline", callID: "pipeline-call" },
  { args: { command } },
);

describe("approval decision pipeline", () => {
  test("lets a user allow bypass a scanner block and the LLM", async () => {
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

  test("lets a user deny bypass the scanner and LLM", async () => {
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

  test("lets a builtin low-risk allow bypass the scanner and LLM", async () => {
    // Given no matching user rule and a common builtin command.
    const fixture = pipelineFixture({});
    try {
      // When the builtin command is evaluated.
      const action = runCommand(fixture, "echo ok");

      // Then the builtin stage is terminal.
      await expect(action).resolves.toBeUndefined();
      expect(fixture.scans()).toEqual([]);
      expect(fixture.reviewCount()).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  test("runs the scanner before the LLM when deterministic rules do not match", async () => {
    // Given a command outside both deterministic rule stages.
    const fixture = pipelineFixture({});
    try {
      // When the scanner allows it and contextual judgment is still needed.
      const action = runCommand(fixture, "scanner-allow");

      // Then scanner evidence exists before the only LLM call.
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

      // Then the complete raw pipeline still reaches scanner and LLM.
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
