import { describe, expect, test } from "bun:test";
import { APPROVAL_AGENT_NAME } from "../src/approval-agent";
import { createApprovalReader } from "../src/approval-reader";
import type { StaticFileReference } from "../src/types";
import { FakeAnchoredFsAdapter, mustReaderResult } from "./fixtures/fake-anchored-fs";

const reference = (
  value: string,
  cwd = "/workspace",
  kind: StaticFileReference["kind"] = "shell_script",
): StaticFileReference => ({
  kind,
  raw: value,
  value,
  topLevelSegment: 0,
  cwd,
});

const context = (overrides: Partial<{ sessionID: string; agent: string; directory: string; abort: AbortSignal }> = {}) => ({
  sessionID: overrides.sessionID ?? "child-1",
  agent: overrides.agent ?? APPROVAL_AGENT_NAME,
  directory: overrides.directory ?? "/workspace",
  abort: overrides.abort ?? new AbortController().signal,
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

describe("approval reader leases", () => {
  test("deduplicates proven aliases and disposes leases before instance roots and adapter", () => {
    // Given: two lexical temp roots anchored to one directory identity.
    const adapter = new FakeAnchoredFsAdapter();
    adapter.addDirectory("/workspace");
    adapter.addDirectory("/tmp");
    expect(adapter.alias("/tmp", "/private/tmp")).toBe(true);

    // When: the instance creates a lease and is disposed.
    const reader = mustReaderResult(createApprovalReader({
      adapter,
      workspaceRoot: "/workspace",
      tempRoots: [{ spelling: "/tmp", aliases: ["/private/tmp"] }],
    }));
    adapter.addFile("/tmp/script.sh", "snapshot");
    const lease = mustReaderResult(reader.activate({
      sessionID: "child-1",
      agent: APPROVAL_AGENT_NAME,
      directory: "/workspace",
      references: [reference("/private/tmp/script.sh")],
    }));
    reader.dispose();

    // Then: slash and duplicate alias fds closed during setup, all lease fds precede roots, and FFI disposal is last.
    expect({ generation: lease.generation, active: adapter.activeDescriptors(), last: adapter.events.at(-1) }).toEqual({
      generation: 1,
      active: 0,
      last: "adapter_dispose",
    });
    expect(adapter.events.filter((event) => event.startsWith("close:")).length).toBeGreaterThanOrEqual(5);
  });

  test("rejects mismatched required aliases without retaining roots", () => {
    // Given: two lexical aliases resolving to different anchored identities.
    const adapter = new FakeAnchoredFsAdapter();
    adapter.addDirectory("/workspace");
    adapter.addDirectory("/tmp");
    adapter.addDirectory("/private/tmp");

    // When: root setup requires them to identify the same directory.
    const result = createApprovalReader({
      adapter,
      workspaceRoot: "/workspace",
      tempRoots: [{ spelling: "/tmp", aliases: ["/private/tmp"] }],
    });

    // Then: setup fails closed, closes every descriptor, and disposes the adapter.
    expect(result).toEqual({ ok: false, code: "reader_unavailable" });
    expect({ active: adapter.activeDescriptors(), disposed: adapter.disposed }).toEqual({ active: 0, disposed: true });
  });

  test("reads workspace on demand and only statically leased temp snapshots", () => {
    // Given: one workspace file, one Todo1 static temp reference, and one unreferenced temp file.
    const { adapter, reader } = setup();
    adapter.addFile("/workspace/readme.txt", "workspace");
    const original = adapter.addFile("/tmp/script.sh", "original");
    adapter.addFile("/tmp/unleased.sh", "blocked");
    const lease = mustReaderResult(reader.activate({
      sessionID: "child-1",
      agent: APPROVAL_AGENT_NAME,
      directory: "/workspace",
      references: [reference("/tmp/script.sh")],
    }));
    adapter.replace("/tmp/script.sh", adapter.addFile("/replacement.sh", "replacement"));

    // When: the fixed agent requests workspace, leased temp, and unleased temp paths.
    const workspace = reader.read({ path: "readme.txt" }, context());
    const temp = reader.read({ path: "/tmp/script.sh" }, context());
    const unleased = reader.read({ path: "/tmp/unleased.sh" }, context());

    // Then: workspace and retained original inode succeed; the unreferenced path exposes no content.
    expect(workspace).toBe('{"ok":true,"path":"readme.txt","offset":0,"bytes":9,"content":"workspace"}');
    expect(temp).toBe('{"ok":true,"path":"/tmp/script.sh","offset":0,"bytes":8,"content":"original"}');
    expect(unleased).toBe('{"ok":false,"error":"unauthorized"}');
    expect({ lease: lease.generation, original: original.ino }).toEqual({ lease: 1, original: original.ino });
  });

  test("leases Todo1 leading-dot shell, source, and input references beneath their cwd", () => {
    // Given: the common Todo1 relative spellings plus sensitive and escaping lookalikes.
    const { adapter, reader } = setup();
    adapter.addFile("/tmp/script.sh", "script");
    adapter.addFile("/tmp/profile", "profile");
    adapter.addFile("/tmp/input", "input");
    adapter.addFile("/tmp/.env", "secret");
    adapter.addFile("/outside/escape", "outside");
    mustReaderResult(reader.activate({
      sessionID: "child-1",
      agent: APPROVAL_AGENT_NAME,
      directory: "/workspace",
      references: [
        reference("./script.sh", "/tmp"), reference("./profile", "/tmp", "source"),
        reference("./input", "/tmp", "input_redirect"),
        reference("./.env", "/tmp"), reference("../escape", "/tmp"), reference("dir/../escape", "/tmp"),
        reference("./escape", "/outside"),
      ],
    }));

    // When: the exact absolute lease keys are requested by the fixed approval agent.
    const results = ["/tmp/script.sh", "/tmp/profile", "/tmp/input", "/tmp/.env", "/outside/escape"].map((path) =>
      reader.read({ path }, context()));

    // Then: ordinary leading-dot references map safely while sensitive and escaping records lease nothing.
    expect(results).toEqual([
      '{"ok":true,"path":"/tmp/script.sh","offset":0,"bytes":6,"content":"script"}',
      '{"ok":true,"path":"/tmp/profile","offset":0,"bytes":7,"content":"profile"}',
      '{"ok":true,"path":"/tmp/input","offset":0,"bytes":5,"content":"input"}',
      '{"ok":false,"error":"sensitive_path"}',
      '{"ok":false,"error":"unauthorized"}',
    ]);
  });

  test.each([
    ["session", context({ sessionID: "other" })],
    ["agent", context({ agent: "other" })],
    ["directory", context({ directory: "/other" })],
    ["abort", context({ abort: AbortSignal.abort() })],
  ])("denies a mismatched %s without opening a file", (_label, toolContext) => {
    // Given: one active exact lease and an authorization mismatch.
    const { adapter, reader } = setup();
    adapter.addFile("/workspace/readme.txt", "content");
    mustReaderResult(reader.activate({
      sessionID: "child-1",
      agent: APPROVAL_AGENT_NAME,
      directory: "/workspace",
      references: [],
    }));
    const before = adapter.events.length;

    // When: the guarded tool is invoked.
    const result = reader.read({ path: "readme.txt" }, toolContext);

    // Then: authorization fails before descriptor traversal.
    expect(result).toBe('{"ok":false,"error":"unauthorized"}');
    expect(adapter.events.length).toBe(before);
  });

  test("enforces exact generations, offset defaults, EOF, and the 65536-byte cap", () => {
    // Given: a long workspace file and two successive generations for one child session.
    const { adapter, reader } = setup();
    adapter.addFile("/workspace/long.txt", "x".repeat(70_000));
    const stale = mustReaderResult(reader.activate({ sessionID: "child-1", agent: APPROVAL_AGENT_NAME, directory: "/workspace", references: [] }));
    const current = mustReaderResult(reader.activate({ sessionID: "child-1", agent: APPROVAL_AGENT_NAME, directory: "/workspace", references: [] }));

    // When: stale/current revocation and boundary reads execute.
    const staleRevoked = reader.revoke(stale);
    const capped = reader.read({ path: "long.txt" }, context());
    const eof = reader.read({ path: "long.txt", offset: 70_000 }, context());
    const currentRevoked = reader.revoke(current);
    const after = reader.read({ path: "long.txt" }, context());

    // Then: stale generation cannot revoke current, reads cap/EOF deterministically, and exact revoke removes access.
    expect(staleRevoked).toBe(false);
    expect(capped.startsWith('{"ok":true,"path":"long.txt","offset":0,"bytes":65536,"content":"')).toBe(true);
    expect(eof).toBe('{"ok":true,"path":"long.txt","offset":70000,"bytes":0,"content":""}');
    expect({ currentRevoked, after }).toEqual({ currentRevoked: true, after: '{"ok":false,"error":"revoked"}' });
  });

  test.each([
    [{ path: "" }], [{ path: "file", offset: -1 }], [{ path: "file", offset: 0.5 }],
    [{ path: "file", offset: Number.MAX_SAFE_INTEGER + 1 }], [{ path: "file", offset: "0" }],
    [{ path: "file", extra: true }],
  ])("rejects invalid tool arguments without content: %j", (args) => {
    // Given: an untrusted argument shape outside the exact path/offset schema.
    const { reader } = setup();
    mustReaderResult(reader.activate({ sessionID: "child-1", agent: APPROVAL_AGENT_NAME, directory: "/workspace", references: [] }));

    // When: argument parsing runs at the tool boundary.
    const result = reader.read(args, context());

    // Then: only the stable machine error is returned.
    expect(result).toBe('{"ok":false,"error":"invalid_arguments"}');
  });
});
