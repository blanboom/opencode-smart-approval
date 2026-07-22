import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@opencode-ai/plugin";
import { APPROVAL_AGENT_NAME } from "../src/approval-agent";
import { createUnsupportedAnchoredFsAdapter } from "../src/anchored-fs-unsupported";
import { APPROVAL_READ_TOOL_NAME, createApprovalPluginIntegration } from "../src/index";
import { FakeAnchoredFsAdapter, mustReaderResult } from "./fixtures/fake-anchored-fs";
import { fakeClient } from "./fixtures/opencode-client-fake";

type ContextOverrides = Partial<Pick<
  ToolContext,
  "sessionID" | "agent" | "directory" | "worktree" | "abort"
>>;

const toolContext = (overrides: ContextOverrides = {}): ToolContext => ({
  sessionID: overrides.sessionID ?? "child-1",
  messageID: "message-1",
  agent: overrides.agent ?? APPROVAL_AGENT_NAME,
  directory: overrides.directory ?? "/workspace",
  worktree: overrides.worktree ?? "/workspace",
  abort: overrides.abort ?? new AbortController().signal,
  metadata: () => undefined,
  ask: async () => undefined,
});

const configuredIntegration = () => {
  const adapter = new FakeAnchoredFsAdapter();
  adapter.addDirectory("/workspace");
  adapter.addDirectory("/tmp");
  adapter.addFile("/workspace/readme.txt", "workspace");
  const before = async () => undefined;
  const integration = createApprovalPluginIntegration(
    { directory: "/workspace", worktree: "/workspace" },
    {
      adapter,
      environment: { XDG_DATA_HOME: "/isolated/data" },
      homeDirectory: "/unused-home",
      tempDirectory: "/tmp",
      createToolExecuteBefore: () => before,
    },
  );
  return { adapter, before, integration };
};

describe("approval plugin integration", () => {
  test("overwrites the fixed agent while preserving unrelated configured agents", async () => {
    // Given a plugin integration and a hostile same-name definition beside an unrelated agent.
    const { integration } = configuredIntegration();
    const unrelated = { description: "keep", prompt: "keep", mode: "subagent" as const };
    const config = {
      small_model: "test/model",
      agent: {
        unrelated,
        [APPROVAL_AGENT_NAME]: { description: "replace", prompt: "unsafe", mode: "primary" as const },
      },
    };
    const configure = integration.hooks.config;
    if (!configure) throw new TypeError("missing config hook");

    // When the official configuration hook is applied.
    await configure(config);

    // Then only the owned name is replaced and the retained expected snapshot is immutable.
    const expected = integration.expectedAgent();
    if (!expected) throw new TypeError("missing expected agent snapshot");
    expect(config.agent.unrelated).toBe(unrelated);
    expect(JSON.stringify(config.agent[APPROVAL_AGENT_NAME])).toBe(JSON.stringify(expected.config));
    expect(Object.isFrozen(expected)).toBe(true);
    expect(integration.promptTools).toEqual({ "*": false, opencode_smart_approval_read: true });
    expect(Object.isFrozen(integration.promptTools)).toBe(true);
    await integration.hooks.dispose?.();
  });

  test("reads through the actual exported tool only for the active owned context", async () => {
    // Given an exported integration whose fixed agent owns one active child-session lease.
    const { before, integration } = configuredIntegration();
    mustReaderResult(integration.activate({
      sessionID: "child-1",
      agent: APPROVAL_AGENT_NAME,
      directory: "/workspace",
      references: [],
    }));
    const readTool = integration.hooks.tool?.[APPROVAL_READ_TOOL_NAME];
    if (!readTool) throw new TypeError("missing read tool");

    // When the exact context and a mismatched worktree invoke that same exported definition.
    const allowed = await readTool.execute({ path: "readme.txt", offset: 0 }, toolContext());
    const denied = await readTool.execute(
      { path: "readme.txt", offset: 0 },
      toolContext({ worktree: "/other" }),
    );

    // Then deterministic reader JSON is returned and the original command hook remains untouched.
    expect(allowed).toBe('{"ok":true,"path":"readme.txt","offset":0,"bytes":9,"content":"workspace"}');
    expect(denied).toBe('{"ok":false,"error":"unauthorized"}');
    expect(integration.hooks["tool.execute.before"]).toBe(before);
    expect(Object.keys(integration.hooks.tool ?? {})).toEqual([APPROVAL_READ_TOOL_NAME]);
    await integration.hooks.dispose?.();
  });

  test("loads fail-closed when the descriptor reader is unavailable", async () => {
    // Given an unsupported anchored adapter at plugin startup.
    const integration = createApprovalPluginIntegration(
      { directory: "/workspace", worktree: "/workspace" },
      {
        adapter: createUnsupportedAnchoredFsAdapter(),
        tempDirectory: "/tmp",
        createToolExecuteBefore: () => async () => undefined,
      },
    );
    const readTool = integration.hooks.tool?.[APPROVAL_READ_TOOL_NAME];
    if (!readTool) throw new TypeError("missing read tool");

    // When activation and the owned tool are attempted after successful plugin loading.
    const activation = integration.activate({
      sessionID: "child-1",
      agent: APPROVAL_AGENT_NAME,
      directory: "/workspace",
      references: [],
    });
    const read = await readTool.execute({ path: "readme.txt", offset: 0 }, toolContext());

    // Then both boundaries expose only the fixed unavailable code and no pathname fallback.
    expect(activation).toEqual({ ok: false, code: "reader_unavailable" });
    expect(read).toBe('{"ok":false,"error":"reader_unavailable"}');
    expect(Object.keys(integration.hooks).sort()).toEqual(["config", "dispose", "event", "tool", "tool.execute.before"]);
    await integration.hooks.dispose?.();
  });

  test("rejects invalid and unresolvable directories before hook construction, root calls, or leases", async () => {
    // Given invalid syntax and an absolute root the anchored adapter cannot resolve.
    for (const directory of ["relative/workspace", "/missing-workspace"] as const) {
      const adapter = new FakeAnchoredFsAdapter();
      adapter.addDirectory("/tmp");
      const client = fakeClient(async () => ({ data: {} }));
      let factoryCalls = 0;
      const integration = createApprovalPluginIntegration(
        { directory, project: { id: "project-id" }, client: client.client },
        {
          adapter,
          tempDirectory: "/tmp",
          createToolExecuteBefore: () => {
            factoryCalls += 1;
            return async () => undefined;
          },
        },
      );
      const before = integration.hooks["tool.execute.before"];
      if (!before) throw new TypeError("missing command hook");

      // When activation and command execution are attempted.
      const activation = integration.activate({
        sessionID: "child-1",
        agent: APPROVAL_AGENT_NAME,
        directory,
        references: [],
      });
      const execution = before(
        { tool: "bash", sessionID: "parent", callID: "call" },
        { args: { command: "scanner-allow" } },
      );

      // Then neither the factory, OpenCode root client, nor a reader lease is reached.
      expect(activation).toEqual({ ok: false, code: "reader_unavailable" });
      await expect(execution).rejects.toThrow("approval plugin roots are unavailable");
      expect(factoryCalls).toBe(0);
      expect(client.calls).toEqual([]);
      await integration.hooks.dispose?.();
    }
  });

  test("disposes every owned descriptor exactly once and blocks later reads", async () => {
    // Given initialized roots and an active workspace lease.
    const { adapter, integration } = configuredIntegration();
    mustReaderResult(integration.activate({
      sessionID: "child-1",
      agent: APPROVAL_AGENT_NAME,
      directory: "/workspace",
      references: [],
    }));
    const readTool = integration.hooks.tool?.[APPROVAL_READ_TOOL_NAME];
    const dispose = integration.hooks.dispose;
    if (!readTool || !dispose) throw new TypeError("missing lifecycle hook");
    expect(adapter.activeDescriptors()).toBeGreaterThan(0);

    // When the official disposal hook runs twice and the old tool definition is invoked again.
    await dispose();
    await dispose();
    const afterDispose = await readTool.execute({ path: "readme.txt", offset: 0 }, toolContext());

    // Then leases and roots close once before physical adapter drain, and access stays unavailable.
    const ledger = adapter.descriptorLedger();
    expect(ledger).toEqual({ opened: ledger.opened, closeCalls: ledger.opened, active: 0 });
    expect(adapter.events.at(-1)).toBe("adapter_dispose");
    expect(afterDispose).toBe('{"ok":false,"error":"reader_unavailable"}');
    expect(integration.revoke({ sessionID: "child-1", generation: 1 })).toBe(false);
  });
});
