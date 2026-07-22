import { describe, expect, test } from "bun:test";
import { APPROVAL_AGENT_NAME } from "../src/approval-agent";
import { createApprovalReader, type ApprovalLeaseActivation } from "../src/approval-reader";
import type { StaticFileReference } from "../src/types";
import { FakeAnchoredFsAdapter, mustReaderResult } from "./fixtures/fake-anchored-fs";

const reference = (value: string): StaticFileReference => ({
  kind: "shell_script",
  raw: value,
  value,
  topLevelSegment: 0,
  cwd: "/workspace",
});

const activation = (references: readonly StaticFileReference[] = []): ApprovalLeaseActivation => ({
  sessionID: "child-1",
  agent: APPROVAL_AGENT_NAME,
  directory: "/workspace",
  references,
});

const context = () => ({
  sessionID: "child-1",
  agent: APPROVAL_AGENT_NAME,
  directory: "/workspace",
  abort: new AbortController().signal,
});

const setup = () => {
  const adapter = new FakeAnchoredFsAdapter();
  adapter.addDirectory("/workspace");
  adapter.addDirectory("/tmp");
  const reader = mustReaderResult(createApprovalReader({
    adapter,
    workspaceRoot: "/workspace",
    tempRoots: [{ spelling: "/tmp" }],
  }));
  return { adapter, reader };
};

describe("approval reader races", () => {
  test("returns revoked without content when the lease is revoked during read", () => {
    // Given: an active lease whose descriptor read triggers exact-generation revocation.
    const { adapter, reader } = setup();
    adapter.addFile("/workspace/file.txt", "secret");
    const lease = mustReaderResult(reader.activate(activation()));
    adapter.setBarrier((event) => {
      if (event === "during_read") reader.revoke(lease);
    });

    // When: reading crosses the revocation barrier.
    const result = reader.read({ path: "file.txt" }, context());

    // Then: no bytes from the revoked generation are returned.
    expect(result).toBe('{"ok":false,"error":"revoked"}');
    expect(result).not.toContain("secret");
  });

  test("returns revoked without content when disposal occurs during read", () => {
    // Given: a live reader disposed at the descriptor read barrier.
    const { adapter, reader } = setup();
    adapter.addFile("/workspace/file.txt", "secret");
    mustReaderResult(reader.activate(activation()));
    adapter.setBarrier((event) => {
      if (event === "during_read") reader.dispose();
    });

    // When: the in-flight read resumes after disposal.
    const result = reader.read({ path: "file.txt" }, context());

    // Then: disposal revokes the in-flight result and leaves no descriptors owned.
    expect(result).toBe('{"ok":false,"error":"revoked"}');
    expect({ content: result.includes("secret"), active: adapter.activeDescriptors() }).toEqual({ content: false, active: 0 });
  });

  test("returns revoked when file link identity changes during read", () => {
    // Given: a regular single-link file whose link count changes after its bytes are copied.
    const { adapter, reader } = setup();
    const file = adapter.addFile("/workspace/file.txt", "secret");
    mustReaderResult(reader.activate(activation()));
    adapter.setBarrier((event) => {
      if (event === "during_read") file.nlink = 2n;
    });

    // When: the snapshot is revalidated after reading.
    const result = reader.read({ path: "file.txt" }, context());

    // Then: the changed snapshot is rejected without content.
    expect(result).toBe('{"ok":false,"error":"revoked"}');
  });

  test("redacts an unexpected adapter error and closes the workspace file", () => {
    // Given: one active lease and a fake adapter that throws after opening its workspace file.
    const { adapter, reader } = setup();
    adapter.addFile("/workspace/file.txt", "content");
    mustReaderResult(reader.activate(activation()));
    const baseline = adapter.activeDescriptors();
    adapter.setBarrier((event) => {
      if (event === "during_read") throw new TypeError("fake adapter failure");
    });

    // When: the unexpected test-only adapter exception crosses the public reader boundary.
    const result = reader.read({ path: "file.txt" }, context());

    // Then: only a deterministic machine error returns and the transient descriptor closes.
    expect(result).toBe('{"ok":false,"error":"reader_unavailable"}');
    expect(result).not.toContain("fake adapter failure");
    expect(adapter.activeDescriptors()).toBe(baseline);
  });

  test.each(["open", "stat", "read", "close", "lease"])("redacts every %s boundary Error", (boundary) => {
    // Given: one active read and a boundary-specific dummy provider secret.
    const { adapter, reader } = setup();
    adapter.addFile("/workspace/file.txt", "content");
    mustReaderResult(reader.activate(activation()));
    let stats = 0;
    adapter.setBarrier((event) => {
      if (event === "before_stat") stats += 1;
      const selected = (boundary === "open" && event === "before_open:file.txt")
        || (boundary === "stat" && event === "before_stat" && stats === 2)
        || (boundary === "read" && event === "during_read")
        || (boundary === "close" && event === "after_close");
      if (selected) throw new TypeError(`NATIVE_PROVIDER_SECRET_${boundary}`);
    });
    const toolContext = boundary === "lease" ? {
      get sessionID(): string { throw new TypeError("NATIVE_PROVIDER_SECRET_lease"); },
      agent: APPROVAL_AGENT_NAME,
      directory: "/workspace",
      abort: new AbortController().signal,
    } : context();

    // When: the public read boundary invokes the selected failure point.
    const result = reader.read({ path: "file.txt" }, toolContext);

    // Then: one fixed machine result contains no error name, message, stack, or content.
    expect(result).toBe('{"ok":false,"error":"reader_unavailable"}');
    expect(result).not.toContain("NATIVE_PROVIDER_SECRET");
    expect(result).not.toContain("content");
  });

  test("preserves revoked as the primary result when transient close throws", () => {
    // Given: revocation during pread followed by an exceptional close of the transient file.
    const { adapter, reader } = setup();
    adapter.addFile("/workspace/file.txt", "secret");
    const lease = mustReaderResult(reader.activate(activation()));
    let closes = 0;
    adapter.setBarrier((event) => {
      if (event === "during_read") reader.revoke(lease);
      if (event === "after_close") {
        closes += 1;
        if (closes === 2) throw new TypeError("NATIVE_PROVIDER_SECRET_close");
      }
    });

    // When: post-read lease validation wins before cleanup completes.
    const result = reader.read({ path: "file.txt" }, context());

    // Then: cleanup failure neither leaks content nor masks the primary revoked outcome.
    expect(result).toBe('{"ok":false,"error":"revoked"}');
    expect(result).not.toContain("NATIVE_PROVIDER_SECRET");
  });

  test("keeps traversal anchored when an intermediate namespace entry is replaced", () => {
    // Given: an original child directory and a replacement namespace directory with different bytes.
    const { adapter, reader } = setup();
    adapter.addFile("/workspace/project/file.txt", "original");
    adapter.addFile("/replacement/file.txt", "replacement");
    const replacement = adapter.nodeAt("/replacement");
    if (!replacement) throw new TypeError("missing replacement fixture");
    mustReaderResult(reader.activate(activation()));
    adapter.setBarrier((event) => {
      if (event === "after_open:project") adapter.replace("/workspace/project", replacement);
    });

    // When: traversal continues through the already-open directory descriptor.
    const result = reader.read({ path: "project/file.txt" }, context());

    // Then: namespace replacement cannot redirect the descriptor walk.
    expect(result).toBe('{"ok":true,"path":"project/file.txt","offset":0,"bytes":8,"content":"original"}');
  });

  test("leases the opened temp inode when activation replaces its pathname", () => {
    // Given: activation opens a referenced temp file before its pathname is replaced.
    const { adapter, reader } = setup();
    adapter.addFile("/tmp/script.sh", "original");
    const replacement = adapter.addFile("/replacement.sh", "replacement");
    adapter.setBarrier((event) => {
      if (event === "after_open:script.sh") adapter.replace("/tmp/script.sh", replacement);
    });

    // When: activation finishes and the tool reads the exact leased lexical key.
    mustReaderResult(reader.activate(activation([reference("/tmp/script.sh")])));
    const result = reader.read({ path: "/tmp/script.sh" }, context());

    // Then: the retained descriptor exposes only the originally opened inode.
    expect(result).toBe('{"ok":true,"path":"/tmp/script.sh","offset":0,"bytes":8,"content":"original"}');
  });

  test("discards namespace replacement after pread and returns original bytes", () => {
    // Given: an on-demand workspace read whose pathname changes after descriptor bytes are copied.
    const { adapter, reader } = setup();
    adapter.addFile("/workspace/file.txt", "original");
    const replacement = adapter.addFile("/replacement.txt", "replacement");
    mustReaderResult(reader.activate(activation()));
    adapter.setBarrier((event) => {
      if (event === "after_read") adapter.replace("/workspace/file.txt", replacement);
    });

    // When: the read returns after post-pread descriptor revalidation.
    const result = reader.read({ path: "file.txt" }, context());

    // Then: pathname replacement cannot alter the already-open file snapshot.
    expect(result).toBe('{"ok":true,"path":"file.txt","offset":0,"bytes":8,"content":"original"}');
  });

  test("never leases symlink, special, or hard-linked temp references", () => {
    // Given: static references resolving to disallowed descriptor kinds or link counts.
    const { adapter, reader } = setup();
    adapter.addSymlink("/tmp/link.sh");
    adapter.addOther("/tmp/pipe");
    adapter.addFile("/tmp/hard.sh", "linked", 2n);
    mustReaderResult(reader.activate(activation([
      reference("/tmp/link.sh"), reference("/tmp/pipe"), reference("/tmp/hard.sh"),
    ])));

    // When: the approval agent requests each referenced path.
    const results = ["/tmp/link.sh", "/tmp/pipe", "/tmp/hard.sh"].map((path) => reader.read({ path }, context()));

    // Then: activation retained none of them and every read is denied without probing again.
    expect(results).toEqual(Array.from({ length: 3 }, () => '{"ok":false,"error":"unauthorized"}'));
  });
});
