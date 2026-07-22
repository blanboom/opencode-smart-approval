import { expect, test } from "bun:test";
import { closeSync, fstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalRootSpelling,
  openAnchoredRegularFile,
  openAnchoredRoot,
  type AnchoredFsAdapter,
  type ReaderResult,
} from "../src/anchored-fs";
import { createPosixAnchoredFsAdapter } from "../src/anchored-fs-posix";
import { APPROVAL_AGENT_NAME } from "../src/approval-agent";
import { createApprovalReader } from "../src/approval-reader";
import { mustReaderResult } from "./fixtures/fake-anchored-fs";

const isBadFd = (fd: number): boolean => {
  try {
    fstatSync(fd);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EBADF";
  }
};

test.skipIf(process.platform !== "darwin")("real Darwin FFI reads regular files and rejects FIFO without blocking", () => {
  // Given: a real private temp root containing one regular file and one named pipe.
  const directory = mkdtempSync("/private/tmp/opencode-smart-approval-reader-");
  const fifo = join(directory, "pipe");
  const created = Bun.spawnSync({ cmd: ["mkfifo", fifo], stderr: "pipe" });
  expect(created.exitCode).toBe(0);
  writeFileSync(join(directory, "file.txt"), "ffi-content");
  const adapter = createPosixAnchoredFsAdapter();

  try {
    // When: the real libc adapter traverses the root and opens both descriptor kinds.
    expect(adapter.available).toBe(true);
    const slash = mustReaderResult(adapter.openRoot());
    const root = mustReaderResult(openAnchoredRoot(adapter, slash, mustReaderResult(canonicalRootSpelling(directory))));
    const file = mustReaderResult(openAnchoredRegularFile(adapter, root, ["file.txt"]));
    const content = Buffer.from(mustReaderResult(adapter.read(file.fd, 0, 65_536))).toString("utf8");
    const started = performance.now();
    const pipe = openAnchoredRegularFile(adapter, root, ["pipe"]);
    const elapsed = performance.now() - started;

    // Then: regular bytes are returned, FIFO is classified after nonblocking open, and owned fds close.
    expect({ content, pipe }).toEqual({ content: "ffi-content", pipe: { ok: false, code: "not_regular" } });
    expect(elapsed).toBeLessThan(1_000);
    expect(adapter.close(file.fd).ok).toBe(true);
    expect(adapter.close(root.fd).ok).toBe(true);
    expect(adapter.close(slash).ok).toBe(true);
  } finally {
    adapter.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin")("real Darwin adapter closes an owned fd after logical disposal", () => {
  // Given: one real root descriptor still owned when logical adapter disposal begins.
  const adapter = createPosixAnchoredFsAdapter();
  const fd = mustReaderResult(adapter.openRoot());
  let manuallyClosed = false;

  try {
    // When: the owner closes its descriptor after disposal has disabled native traversal.
    adapter.dispose();
    const result = adapter.close(fd);
    const closedAtKernel = isBadFd(fd);

    // Then: close succeeds exactly once and the kernel reports EBADF for the released fd.
    expect(result).toEqual({ ok: true, value: undefined });
    expect(closedAtKernel).toBe(true);
  } finally {
    try {
      closeSync(fd);
      manuallyClosed = true;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
    adapter.dispose();
    expect(manuallyClosed).toBe(false);
  }
});

test.skipIf(process.platform !== "darwin")("real Darwin disposal during read drains every descriptor before FFI close", () => {
  // Given: a real workspace file and a tracking adapter that triggers disposal inside positioned read.
  const directory = mkdtempSync("/private/tmp/opencode-smart-approval-dispose-read-");
  writeFileSync(join(directory, "file.txt"), "native-content");
  const native = createPosixAnchoredFsAdapter();
  const active = new Set<number>();
  let readFd: number | undefined;
  let disposeDuringRead: (() => void) | undefined;
  const tracked = (result: ReaderResult<number>): ReaderResult<number> => {
    if (result.ok) active.add(result.value);
    return result;
  };
  const adapter: AnchoredFsAdapter = {
    available: native.available,
    openRoot: () => tracked(native.openRoot()),
    openAt: (request) => tracked(native.openAt(request)),
    stat: (fd) => native.stat(fd),
    read: (fd, offset, length) => {
      readFd = fd;
      const result = native.read(fd, offset, length);
      const dispose = disposeDuringRead;
      disposeDuringRead = undefined;
      dispose?.();
      return result;
    },
    close: (fd) => {
      const result = native.close(fd);
      if (result.ok) active.delete(fd);
      return result;
    },
    dispose: () => native.dispose(),
  };
  let cleanupReader: (() => void) | undefined;

  try {
    // When: the active reader is disposed after native pread but before lease revalidation.
    const reader = mustReaderResult(createApprovalReader({ adapter, workspaceRoot: directory, tempRoots: [] }));
    cleanupReader = () => reader.dispose();
    mustReaderResult(reader.activate({
      sessionID: "child-1", agent: APPROVAL_AGENT_NAME, directory, references: [],
    }));
    disposeDuringRead = () => reader.dispose();
    const result = reader.read({ path: "file.txt" }, {
      sessionID: "child-1", agent: APPROVAL_AGENT_NAME, directory, abort: new AbortController().signal,
    });
    const transientClosed = readFd === undefined ? false : isBadFd(readFd);

    // Then: revocation wins, late ordinary close drains the transient fd, and no ownership remains.
    expect(result).toBe('{"ok":false,"error":"revoked"}');
    expect({ active: active.size, transientClosed }).toEqual({ active: 0, transientClosed: true });
  } finally {
    disposeDuringRead = undefined;
    cleanupReader?.();
    native.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
