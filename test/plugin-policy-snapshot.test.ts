import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks } from "@opencode-ai/plugin";
import { APPROVAL_AGENT_NAME } from "../src/approval-agent";
import approvalPlugin from "../src/index";
import { fakeClient, type FakeMethod } from "./fixtures/opencode-client-fake";
import { expectedAgentFixture, validCreatedSession, validPromptResponse } from "./fixtures/opencode-review-fixtures";

const temporaryDirectories: string[] = [];
const TEMPORARY_ROOT = realpathSync(tmpdir());

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(TEMPORARY_ROOT, "opencode-smart-approval-policy-snapshot-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("production policy snapshot", () => {
  test("shares policy A and one captured client after a client boundary replaces disk with policy B", async () => {
    // Given policy A, an isolated host, and hostile client accessors that reject every second read.
    const directory = realpathSync(join(import.meta.dir, ".."));
    const xdgConfig = temporaryDirectory();
    const xdgData = temporaryDirectory();
    const policyDirectory = join(xdgConfig, "opencode");
    const policyPath = join(policyDirectory, "command-approval.jsonc");
    const model = "reviewer-provider/reviewer-model";
    const policyA = JSON.stringify({
      version: 3,
      review: { model },
      tirith: { enabled: false },
      rules: { allow: [], deny: [], review: [{ match: "^policy-identity$" }] },
    });
    const policyB = JSON.stringify({
      version: 3,
      review: { model: "replacement-provider/replacement-model" },
      tirith: { enabled: false },
      rules: { allow: [], deny: [{ match: "^policy-identity$" }], review: [] },
    });
    mkdirSync(policyDirectory, { recursive: true });
    writeFileSync(policyPath, policyA);
    const expectedAgent = expectedAgentFixture(model, join(xdgData, "opencode", "tool-output", "*"));
    let mutationCount = 0;
    const clientA = fakeClient(async (method: FakeMethod) => {
      if (method === "log") {
        if (mutationCount === 0) {
          mutationCount += 1;
          writeFileSync(policyPath, policyB);
        }
        return { data: true };
      }
      if (method === "agents") {
        return { data: [expectedAgent.runtime] };
      }
      if (method === "create") {
        return { data: { ...validCreatedSession(), directory, projectID: "project-id", parentID: "parent-session" } };
      }
      if (method === "prompt") {
        const response = validPromptResponse();
        return { data: { ...response, info: { ...response.info, path: { cwd: directory, root: directory } } } };
      }
      if (method === "delete") return { data: true };
      return { data: true };
    });
    const clientB = fakeClient(async () => ({ data: false }));
    const accessorCounts: Record<string, number> = {};
    const once = <T>(name: string, value: T): T => {
      accessorCounts[name] = (accessorCounts[name] ?? 0) + 1;
      if (accessorCounts[name] !== 1) throw new Error(`secret-repeat-${name}`);
      return value;
    };
    const app = {
      get agents() { return once("app.agents", clientA.client.app.agents); },
      get log() { return once("app.log", clientA.client.app.log); },
    };
    const session = {
      get messages() { return once("session.messages", clientA.client.session.messages); },
      get create() { return once("session.create", clientA.client.session.create); },
      get prompt() { return once("session.prompt", clientA.client.session.prompt); },
      get abort() { return once("session.abort", clientA.client.session.abort); },
      get delete() { return once("session.delete", clientA.client.session.delete); },
    };
    const capturedClient = {
      get app() { return once("app", app); },
      get session() { return once("session", session); },
    };
    let rootClientReads = 0;
    const input = {
      directory,
      worktree: directory,
      project: { id: "project-id" },
      get client() {
        rootClientReads += 1;
        return rootClientReads === 1 ? capturedClient : clientB.client;
      },
    };
    const previousConfig = process.env["XDG_CONFIG_HOME"];
    const previousData = process.env["XDG_DATA_HOME"];
    const previousTemporary = process.env["TMPDIR"];
    let hooks: Awaited<ReturnType<NonNullable<typeof approvalPlugin.server>>> | undefined;

    // When the real exported server registers its agent and reviews the exact command after the disk mutation.
    process.env["XDG_CONFIG_HOME"] = xdgConfig;
    process.env["XDG_DATA_HOME"] = xdgData;
    process.env["TMPDIR"] = TEMPORARY_ROOT;
    try {
      hooks = await approvalPlugin.server(input);
      const config: Parameters<NonNullable<Hooks["config"]>>[0] = { small_model: "fallback-provider/fallback-model" };
      await hooks.config?.(config);
      expect(config.agent?.[APPROVAL_AGENT_NAME]?.model).toBe(model);
      await Reflect.apply(clientA.client.app.log, clientA.client.app, [{}]);
      const before = hooks["tool.execute.before"];
      if (!before) throw new TypeError("missing production command hook");
      await before(
        { tool: "bash", sessionID: "parent-session", callID: "policy-snapshot-call" },
        { args: { command: "policy-identity" } },
      );
    } finally {
      await hooks?.dispose?.();
      if (previousConfig === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = previousConfig;
      if (previousData === undefined) delete process.env["XDG_DATA_HOME"];
      else process.env["XDG_DATA_HOME"] = previousData;
      if (previousTemporary === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previousTemporary;
    }

    // Then config and command used A, every hostile accessor ran once, and only captured client A was called.
    expect(readFileSync(policyPath, "utf8")).toBe(policyB);
    expect(mutationCount).toBe(1);
    expect(rootClientReads).toBe(1);
    expect(accessorCounts).toEqual({
      app: 1,
      session: 1,
      "app.agents": 1,
      "app.log": 1,
      "session.messages": 1,
      "session.create": 1,
      "session.prompt": 1,
      "session.abort": 1,
      "session.delete": 1,
    });
    expect(clientA.calls.map((call) => call.method)).toEqual([
      "log",
      "messages",
      "agents",
      "create",
      "agents",
      "prompt",
      "delete",
    ]);
    expect(clientB.calls).toEqual([]);
  });
});
