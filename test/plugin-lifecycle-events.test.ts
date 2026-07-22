import { describe, expect, test } from "bun:test";
import { createApprovalPluginIntegration } from "../src/approval-plugin-integration";
import { createReviewHandle } from "../src/review-handle";
import { FakeAnchoredFsAdapter, mustReaderResult } from "./fixtures/fake-anchored-fs";
import { fakeClient } from "./fixtures/opencode-client-fake";

const integrationFixture = (directory = "/workspace") => {
  const adapter = new FakeAnchoredFsAdapter();
  adapter.addDirectory("/workspace");
  adapter.addDirectory("/tmp");
  const client = fakeClient(async (method) =>
    method === "delete" || method === "abort" ? { data: true } : { data: {} });
  const integration = createApprovalPluginIntegration({
    directory,
    worktree: directory,
    project: { id: "project-id" },
    client: client.client,
  }, {
    adapter,
    environment: { XDG_DATA_HOME: "/isolated/data" },
    tempDirectory: "/tmp",
    createToolExecuteBefore: () => async () => undefined,
  });
  const runtime = integration.reviewerRuntime();
  if (!runtime) throw new Error("missing reviewer runtime");
  return { client, integration, runtime };
};

const rootDirectory = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const query = Reflect.get(value, "query");
  if (typeof query !== "object" || query === null || Array.isArray(query)) return undefined;
  const directory = Reflect.get(query, "directory");
  return typeof directory === "string" ? directory : undefined;
};

const addActive = (
  fixture: ReturnType<typeof integrationFixture>,
  childID: string,
  cleanupEnabled: boolean,
) => {
  const lease = mustReaderResult(fixture.integration.activate({
    sessionID: childID,
    agent: "opencode-smart-approval-reviewer",
    directory: "/workspace",
    references: [],
  }));
  const handle = createReviewHandle({
    childID,
    directory: "/workspace",
    cleanupEnabled,
    revoke: fixture.runtime.revoke,
    abort: (signal) => fixture.runtime.adapter.abort({ sessionID: childID, directory: "/workspace", signal }),
    delete: (signal) => fixture.runtime.adapter.delete({ sessionID: childID, directory: "/workspace", signal }),
  });
  if (!fixture.runtime.registry.add(handle) || !handle.activate(lease)) throw new Error("failed to own fixture child");
  return handle;
};

describe("plugin review lifecycle events", () => {
  test("child idle joins one cleanup and ignores duplicate or foreign IDs", async () => {
    // Given one active cleanup-enabled child owned by the integration.
    const fixture = integrationFixture("/workspace/.");
    const handle = addActive(fixture, "child", true);
    const event = fixture.integration.hooks.event;
    if (!event) throw new Error("missing event hook");

    // When foreign, exact, and duplicate idle events arrive.
    await event({ event: { type: "session.idle", properties: { sessionID: "foreign" } } });
    await event({ event: { type: "session.idle", properties: { sessionID: "child" } } });
    await event({ event: { type: "session.idle", properties: { sessionID: "child" } } });

    // Then only one exact delete occurs and ownership is terminal.
    expect(fixture.client.calls.filter((call) => call.method === "delete")).toHaveLength(1);
    expect(handle.snapshot().state).toBe("deleted");
    await fixture.integration.hooks.dispose?.();
  });

  test("retained idle survives disposal while an active opt-out is abnormally cleaned", async () => {
    // Given two cleanup-disabled children, one made retained by idle.
    const fixture = integrationFixture("/workspace/.");
    const retained = addActive(fixture, "retained", false);
    const active = addActive(fixture, "active", false);
    const event = fixture.integration.hooks.event;
    if (!event) throw new Error("missing event hook");
    await event({ event: { type: "session.idle", properties: { sessionID: "retained" } } });

    // When matching instance disposal arrives twice.
    await event({ event: { type: "server.instance.disposed", properties: { directory: "/workspace/nested/.." } } });
    await event({ event: { type: "server.instance.disposed", properties: { directory: "/workspace/nested/.." } } });

    // Then retained stays retained while active abnormal cleanup overrides opt-out exactly once.
    expect([retained.snapshot().state, active.snapshot().state]).toEqual(["retained", "deleted"]);
    expect(fixture.client.calls.filter((call) => call.method === "delete")).toHaveLength(1);
    expect(fixture.client.calls.filter((call) => call.method === "delete").map((call) => rootDirectory(call.options)))
      .toEqual(["/workspace"]);
    await fixture.integration.hooks.dispose?.();
  });

  test("exact external deletion is terminal and mismatched directory is ignored", async () => {
    // Given one active child and the source-shaped deleted session identity.
    const fixture = integrationFixture();
    const handle = addActive(fixture, "child", true);
    const event = fixture.integration.hooks.event;
    if (!event) throw new Error("missing event hook");
    const info = {
      id: "child", projectID: "project-id", parentID: "parent", title: "review", version: "1.17.14",
      time: { created: 1, updated: 2 },
    };

    // When a wrong-directory deletion precedes the exact event and later idle.
    await event({ event: { type: "session.deleted", properties: { info: { ...info, directory: "/other" } } } });
    await event({ event: { type: "session.deleted", properties: { info: { ...info, directory: "/workspace" } } } });
    await event({ event: { type: "session.idle", properties: { sessionID: "child" } } });

    // Then only the exact deletion revokes ownership and no delete request follows.
    expect(handle.snapshot().state).toBe("deleted");
    expect(fixture.client.calls.filter((call) => call.method === "delete")).toHaveLength(0);
    await fixture.integration.hooks.dispose?.();
  });
});
