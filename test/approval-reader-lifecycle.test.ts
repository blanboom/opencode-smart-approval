import { describe, expect, test } from "bun:test";
import { APPROVAL_AGENT_NAME } from "../src/approval-agent";
import { createApprovalReader, type ApprovalLeaseActivation } from "../src/approval-reader";
import type { StaticFileReference } from "../src/types";
import { FakeAnchoredFsAdapter, mustReaderResult } from "./fixtures/fake-anchored-fs";

const activation = (
  sessionID = "child-1",
  references: readonly StaticFileReference[] = [],
): ApprovalLeaseActivation => ({ sessionID, agent: APPROVAL_AGENT_NAME, directory: "/workspace", references });

const reference = (value: string): StaticFileReference => ({
  kind: "shell_script", raw: value, value, topLevelSegment: 0, cwd: "/workspace",
});

const configuredAdapter = (): FakeAnchoredFsAdapter => {
  const adapter = new FakeAnchoredFsAdapter();
  adapter.addDirectory("/workspace");
  adapter.addDirectory("/tmp");
  if (!adapter.alias("/tmp", "/private/tmp")) throw new TypeError("missing alias fixture");
  return adapter;
};

const configuredReader = () => {
  const adapter = configuredAdapter();
  const reader = mustReaderResult(createApprovalReader({
    adapter,
    workspaceRoot: "/workspace",
    tempRoots: [{ spelling: "/tmp", aliases: ["/private/tmp"] }],
  }));
  return { adapter, reader };
};

describe("approval reader lifecycle errors", () => {
  test.each([
    ["root open", "open_root", 0, 0],
    ["workspace open", "before_open:workspace", 0, 1],
    ["workspace stat", "before_stat", 1, 2],
    ["alias open", "before_open:private", 0, 3],
    ["alias stat", "before_stat", 3, 5],
  ] as const)("redacts %s initialization errors and drains partial roots", (
    _label,
    selectedEvent,
    selectedStat,
    expectedOpened,
  ) => {
    // Given: root initialization fails with a provider secret and every subsequent cleanup close also throws.
    const adapter = configuredAdapter();
    let stats = 0;
    let primaryFired = false;
    adapter.setBarrier((event) => {
      if (event === "before_stat") stats += 1;
      if (event === selectedEvent && (selectedStat === 0 || stats === selectedStat)) {
        primaryFired = true;
        throw new TypeError("ROOT_SECRET_5B");
      }
      if (primaryFired && event === "after_close") throw new Error("CLEANUP_SECRET_5B");
    });

    // When: the public creation boundary opens the retained roots.
    const result = createApprovalReader({
      adapter,
      workspaceRoot: "/workspace",
      tempRoots: [{ spelling: "/tmp", aliases: ["/private/tmp"] }],
    });

    // Then: only a fixed code returns, every acquired fd closes once, and adapter disposal completes.
    expect(result).toEqual({ ok: false, code: "reader_unavailable" });
    expect(JSON.stringify(result)).not.toContain("SECRET_5B");
    expect(adapter.descriptorLedger()).toEqual({
      opened: expectedOpened,
      closeCalls: expectedOpened,
      active: 0,
    });
    expect(adapter.disposed).toBe(true);
  });

  test.each([
    ["duplicate open", "before_open:.", 0],
    ["duplicate stat", "before_stat", 1],
    ["temp open", "before_open:script.sh", 0],
    ["temp stat", "before_stat", 2],
  ] as const)("redacts %s activation errors and drains the draft", (_label, selectedEvent, selectedStat) => {
    // Given: activation encounters one secret-bearing adapter error followed by throwing cleanup closes.
    const { adapter, reader } = configuredReader();
    adapter.addFile("/tmp/script.sh", "content");
    const baseline = adapter.activeDescriptors();
    let stats = 0;
    let primaryFired = false;
    adapter.setBarrier((event) => {
      if (event === "before_stat") stats += 1;
      if (event === selectedEvent && (selectedStat === 0 || stats === selectedStat)) {
        primaryFired = true;
        throw new TypeError("LEASE_SECRET_5B");
      }
      if (primaryFired && event === "after_close") throw new Error("CLEANUP_SECRET_5B");
    });

    // When: the public activation boundary duplicates the workspace and leases the temp reference.
    const result = reader.activate(activation("child-1", [reference("/tmp/script.sh")]));

    // Then: activation fails with one fixed code and retains only the reader's baseline roots.
    expect(result).toEqual({ ok: false, code: "reader_unavailable" });
    expect(JSON.stringify(result)).not.toContain("SECRET_5B");
    expect({ baseline, afterAttempt: adapter.activeDescriptors() }).toEqual({ baseline: 2, afterAttempt: 2 });
    reader.dispose();
    expect(adapter.descriptorLedger()).toEqual({
      opened: adapter.descriptorLedger().opened,
      closeCalls: adapter.descriptorLedger().opened,
      active: 0,
    });
  });

  test("fails closed when replacing an existing lease encounters a cleanup Error", () => {
    // Given: one active generation whose workspace close succeeds and then throws a provider secret.
    const { adapter, reader } = configuredReader();
    mustReaderResult(reader.activate(activation()));
    const baseline = adapter.activeDescriptors();
    adapter.setBarrier((event) => {
      if (event === "after_close") throw new TypeError("REPLACE_SECRET_5B");
    });

    // When: a new activation first revokes the existing generation.
    const result = reader.activate(activation());

    // Then: the replacement is unavailable, the old lease is revoked, and final disposal drains roots.
    expect(result).toEqual({ ok: false, code: "reader_unavailable" });
    expect(JSON.stringify(result)).not.toContain("REPLACE_SECRET_5B");
    expect({ baseline, afterAttempt: adapter.activeDescriptors() }).toEqual({ baseline: 3, afterAttempt: 2 });
    expect(reader.read({ path: "file" }, {
      sessionID: "child-1",
      agent: APPROVAL_AGENT_NAME,
      directory: "/workspace",
      abort: new AbortController().signal,
    })).toBe('{"ok":false,"error":"revoked"}');
    reader.dispose();
    expect(adapter.activeDescriptors()).toBe(0);
  });

  test("revokes deterministically while every owned lease close reports an Error", () => {
    // Given: an exact generation retaining workspace and temp fds whose closes throw after taking ownership.
    const { adapter, reader } = configuredReader();
    adapter.addFile("/tmp/script.sh", "content");
    const handle = mustReaderResult(reader.activate(activation("child-1", [reference("/tmp/script.sh")])));
    const baseline = adapter.activeDescriptors();
    adapter.setBarrier((event) => {
      if (event === "after_close") throw new TypeError("REVOKE_SECRET_5B");
    });

    // When: the exact public handle is revoked.
    const revoked = reader.revoke(handle);

    // Then: logical revocation succeeds, both lease fds drain, and the secret never escapes.
    expect(revoked).toBe(true);
    expect({ baseline, afterRevoke: adapter.activeDescriptors() }).toEqual({ baseline: 4, afterRevoke: 2 });
    reader.dispose();
    expect(adapter.activeDescriptors()).toBe(0);
  });

  test("disposes every lease and root despite close and adapter disposal Errors", () => {
    // Given: two sessions, one retained temp fd, throwing closes, and a secret-bearing adapter dispose Error.
    const { adapter, reader } = configuredReader();
    adapter.addFile("/tmp/script.sh", "content");
    mustReaderResult(reader.activate(activation("child-1", [reference("/tmp/script.sh")])));
    mustReaderResult(reader.activate(activation("child-2")));
    const baseline = adapter.activeDescriptors();
    adapter.setBarrier((event) => {
      if (event === "after_close") throw new TypeError("DISPOSE_CLOSE_SECRET_5B");
    });
    adapter.setDisposeError(new Error("DISPOSE_ADAPTER_SECRET_5B"));

    // When: the public reader is disposed twice.
    const dispose = () => {
      reader.dispose();
      reader.dispose();
    };

    // Then: disposal never throws, all fds close exactly once, and logical adapter disposal completes.
    expect(dispose).not.toThrow();
    expect(baseline).toBe(5);
    expect(adapter.descriptorLedger()).toEqual({
      opened: adapter.descriptorLedger().opened,
      closeCalls: adapter.descriptorLedger().opened,
      active: 0,
    });
    expect(adapter.disposed).toBe(true);
  });
});
