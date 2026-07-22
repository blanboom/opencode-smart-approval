import { describe, expect, test } from "bun:test";
import { APPROVAL_AGENT_NAME } from "../src/approval-agent";
import { createApprovalReader } from "../src/approval-reader";
import type { ApprovalReadContext } from "../src/approval-reader-types";
import { FakeAnchoredFsAdapter, mustReaderResult } from "./fixtures/fake-anchored-fs";

const context = (sessionID: string): ApprovalReadContext => ({
  sessionID,
  agent: APPROVAL_AGENT_NAME,
  directory: "/workspace",
  abort: new AbortController().signal,
});

describe("approval reader retired-session retention", () => {
  test("retains only a bounded recent window of revoked identities", () => {
    const adapter = new FakeAnchoredFsAdapter();
    adapter.addDirectory("/workspace");
    const reader = mustReaderResult(createApprovalReader({
      adapter,
      workspaceRoot: "/workspace",
      tempRoots: [],
    }));
    const baseline = adapter.activeDescriptors();

    for (let index = 0; index <= 1_024; index += 1) {
      const handle = mustReaderResult(reader.activate({
        sessionID: `child-${String(index)}`,
        agent: APPROVAL_AGENT_NAME,
        directory: "/workspace",
        references: [],
      }));
      expect(reader.revoke(handle)).toBe(true);
    }

    expect(reader.read({ path: "file" }, context("child-0"))).toBe('{"ok":false,"error":"unauthorized"}');
    expect(reader.read({ path: "file" }, context("child-1024"))).toBe('{"ok":false,"error":"revoked"}');
    expect(adapter.activeDescriptors()).toBe(baseline);
    reader.dispose();
    expect(adapter.activeDescriptors()).toBe(0);
  });
});
