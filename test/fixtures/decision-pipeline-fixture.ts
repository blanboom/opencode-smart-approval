import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHook } from "../../src/index";
import { expectedAgentFixture, validCreatedSession, validPromptResponse } from "./opencode-review-fixtures";
import { reviewRuntimeFixture } from "./opencode-review-runtime";

export type RuleLists = {
  readonly allow?: readonly unknown[];
  readonly deny?: readonly unknown[];
  readonly review?: readonly unknown[];
  readonly cleanupSession?: boolean;
};

export type PipelineFixture = {
  readonly hook: ReturnType<typeof createHook>;
  readonly scans: () => readonly string[];
  readonly reviewCount: () => number;
  readonly reviewerObservedScan: () => boolean;
  readonly cleanupCount: () => number;
  readonly cleanup: () => void;
};

export const pipelineFixture = (rules: RuleLists): PipelineFixture => {
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
  let children = 0;
  let cleanups = 0;
  const expected = expectedAgentFixture();
  const stringField = (value: unknown, key: string): string | undefined => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const field = Reflect.get(value, key);
    return typeof field === "string" ? field : undefined;
  };
  const responseFor = (childID: string) => {
    const response = validPromptResponse({
      outcome: "allow",
      risk_level: "medium",
      user_authorization: "unknown",
      categories: [{ id: "security.test", score: 0.2 }],
      reasons: ["fake reviewer approval"],
    });
    const messageID = `assistant-${childID}`;
    return {
      ...response,
      info: { ...response.info, id: messageID, sessionID: childID, path: { cwd: directory, root: directory } },
      parts: response.parts.map((part) => ({ ...part, sessionID: childID, messageID })),
    };
  };
  const reviewer = reviewRuntimeFixture(async (method, input) => {
    if (method === "agents") return { ok: true, data: [expected.runtime] };
    if (method === "create") {
      children += 1;
      const parentID = stringField(input, "parentID") ?? "parent";
      return {
        ok: true,
        data: { ...validCreatedSession(), id: `child-${String(children)}`, directory, parentID },
      };
    }
    if (method === "prompt") {
      reviews += 1;
      scanObserved = existsSync(capturePath) && readFileSync(capturePath, "utf8").trim().length > 0;
      return { ok: true, data: responseFor(stringField(input, "sessionID") ?? "child") };
    }
    if (method === "delete") {
      cleanups += 1;
      return { ok: true, data: true };
    }
    return { ok: false, code: "sdk_error" };
  }, { directory, worktree: directory });

  writeFileSync(join(configDirectory, "command-approval.jsonc"), JSON.stringify({
    version: 3,
    self_protection: { enabled: true },
    review: { context_messages: 0, cleanup_session: rules.cleanupSession ?? true },
    tirith: { enabled: true, path: tirithPath, timeout_ms: 5_000, fail_open: false },
    rules: {
      allow: rules.allow ?? [],
      deny: rules.deny ?? [],
      review: rules.review ?? [],
    },
  }));

  const previousXdg = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = xdg;
  const hook = createHook(directory, { reviewerRuntime: () => reviewer.runtime });
  if (previousXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = previousXdg;

  return {
    hook,
    scans: () => existsSync(capturePath)
      ? readFileSync(capturePath, "utf8").trim().split("\n").filter(Boolean)
      : [],
    reviewCount: () => reviews,
    reviewerObservedScan: () => scanObserved,
    cleanupCount: () => cleanups,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
};

export const runCommand = (fixture: PipelineFixture, command: string): Promise<void> => fixture.hook(
  { tool: "bash", sessionID: "pipeline", callID: "pipeline-call" },
  { args: { command } },
);
