import { describe, expect, test } from "bun:test";
import { readerError, readerOk, type DescriptorStat } from "../src/anchored-fs";
import {
  POSIX_TARGETS,
  createPosixAnchoredFsAdapter,
  type PosixIo,
  type PosixNative,
} from "../src/anchored-fs-posix";
import { createUnsupportedAnchoredFsAdapter } from "../src/anchored-fs-unsupported";

const directoryStat = (ino = 1n): DescriptorStat => ({
  dev: 7n,
  ino,
  nlink: 1n,
  size: 0n,
  mtimeNs: 1n,
  ctimeNs: 1n,
  kind: "directory",
});

const fixture = (identity = true) => {
  const openCalls: { readonly operation: "open" | "openat"; readonly flags: number; readonly component: string }[] = [];
  const closed: number[] = [];
  let libraryCloses = 0;
  let nextFd = 40;
  const native: PosixNative = {
    open: (_path, flags) => {
      openCalls.push({ operation: "open", flags, component: "/" });
      nextFd += 1;
      return nextFd;
    },
    openAt: (_parent, path, flags) => {
      openCalls.push({ operation: "openat", flags, component: Buffer.from(path).subarray(0, -1).toString("utf8") });
      nextFd += 1;
      return nextFd;
    },
    closeLibrary: () => {
      libraryCloses += 1;
    },
  };
  const io: PosixIo = {
    stat: (fd) => readerOk(directoryStat(identity || fd % 2 === 1 ? 1n : 2n)),
    read: () => readerOk(new Uint8Array()),
    close: (fd) => {
      closed.push(fd);
      return readerOk(undefined);
    },
  };
  return { native, io, openCalls, closed, libraryCloses: () => libraryCloses };
};

describe("POSIX anchored filesystem adapter", () => {
  test("uses exact target flags, C NUL buffers, and a directory identity startup check", () => {
    // Given: a successful injected Darwin libc boundary and fd-based IO boundary.
    const state = fixture();

    // When: the adapter self-checks and opens each target kind.
    const adapter = createPosixAnchoredFsAdapter({
      platform: "darwin",
      nativeLoader: (library) => library === POSIX_TARGETS.darwin.library ? readerOk(state.native) : readerError("reader_unavailable"),
      io: state.io,
    });
    const startupClosed = state.closed.length;
    const root = adapter.openRoot();
    const parent = root.ok ? root.value : -1;
    const directory = adapter.openAt({ parent, component: "dir", target: "directory" });
    const file = adapter.openAt({ parent, component: "file", target: "file" });
    if (directory.ok) adapter.close(directory.value);
    if (file.ok) adapter.close(file.value);
    if (root.ok) adapter.close(root.value);
    adapter.dispose();

    // Then: startup and runtime calls use only the pinned library and exact flag masks.
    expect(adapter.available).toBe(true);
    expect(state.openCalls.map(({ operation, flags, component }) => ({ operation, flags, component }))).toEqual([
      { operation: "open", flags: 0x0110_0100, component: "/" },
      { operation: "openat", flags: 0x0110_0100, component: "." },
      { operation: "open", flags: 0x0110_0100, component: "/" },
      { operation: "openat", flags: 0x0110_0100, component: "dir" },
      { operation: "openat", flags: 0x0100_0104, component: "file" },
    ]);
    expect({ startupClosed, totalClosed: state.closed.length, libraryCloses: state.libraryCloses() }).toEqual({
      startupClosed: 2, totalClosed: 5, libraryCloses: 1,
    });
  });

  test.each([
    ["unsupported platform", { platform: "win32" as const }],
    ["library failure", { platform: "linux" as const, nativeLoader: () => readerError<PosixNative>("reader_unavailable") }],
    ["self-check mismatch", (() => {
      const state = fixture(false);
      return { platform: "linux" as const, nativeLoader: () => readerOk(state.native), io: state.io };
    })()],
  ])("fails closed with reader_unavailable for %s", (_label, options) => {
    // Given: a target whose platform, loader, or startup identity cannot be trusted.
    // When: the POSIX factory evaluates the startup contract.
    const adapter = createPosixAnchoredFsAdapter(options);

    // Then: no pathname fallback exists and every operation returns the stable unavailable code.
    expect(adapter.available).toBe(false);
    expect(adapter.openRoot()).toEqual({ ok: false, code: "reader_unavailable" });
    expect(adapter.openAt({ parent: 3, component: "file", target: "file" })).toEqual({ ok: false, code: "reader_unavailable" });
  });

  test("keeps the explicit Linux flag set separate from Darwin", () => {
    // Given: the two supported pinned target descriptions.
    // When: their masks are inspected as public adapter evidence.
    const targets = POSIX_TARGETS;

    // Then: Linux retains its own O_DIRECTORY/O_NOFOLLOW/O_CLOEXEC/O_NONBLOCK values.
    expect(targets.linux).toEqual({ library: "libc.so.6", directoryFlags: 0x000b_0000, fileFlags: 0x000a_0800 });
    expect(targets.darwin).toEqual({ library: "/usr/lib/libSystem.B.dylib", directoryFlags: 0x0110_0100, fileFlags: 0x0100_0104 });
  });

  test("normalizes thrown loader, native, and fd operations into stable errors", () => {
    // Given: injected boundaries that throw ordinary Errors at each production operation class.
    const loaderFailure = createPosixAnchoredFsAdapter({
      platform: "darwin",
      nativeLoader: () => { throw new TypeError("loader details"); },
    });
    const state = fixture();
    const native: PosixNative = {
      ...state.native,
      openAt: (parent, path, flags) => {
        const component = Buffer.from(path).subarray(0, -1).toString("utf8");
        if (component === "throw") throw new TypeError("native details");
        return state.native.openAt(parent, path, flags);
      },
    };
    let throwClose = false;
    const io: PosixIo = {
      stat: (fd) => {
        if (fd === 999) throw new TypeError("stat details");
        return state.io.stat(fd);
      },
      read: () => { throw new TypeError("read details"); },
      close: (fd) => {
        if (throwClose) throw new TypeError("close details");
        return state.io.close(fd);
      },
    };

    // When: startup succeeds for one adapter and each throwing public operation executes.
    const adapter = createPosixAnchoredFsAdapter({ platform: "darwin", nativeLoader: () => readerOk(native), io });
    const owned = adapter.openRoot();
    if (!owned.ok) throw new TypeError(owned.code);
    throwClose = true;
    const results = [
      adapter.openAt({ parent: 999, component: "throw", target: "file" }),
      adapter.stat(999),
      adapter.read(999, 0, 1),
      adapter.close(owned.value),
    ];

    // Then: neither provider text nor exceptions escape the stable reader result boundary.
    expect(loaderFailure.available).toBe(false);
    expect(results).toEqual([
      { ok: false, code: "reader_unavailable" },
      { ok: false, code: "reader_unavailable" },
      { ok: false, code: "read_failed" },
      { ok: false, code: "reader_unavailable" },
    ]);
    throwClose = false;
    expect(adapter.close(owned.value)).toEqual({ ok: true, value: undefined });
    adapter.dispose();
  });

  test("defers FFI disposal until the final logically disposed descriptor closes", () => {
    // Given: a live injected adapter with one descriptor still owned by its caller.
    const state = fixture();
    const adapter = createPosixAnchoredFsAdapter({
      platform: "darwin", nativeLoader: () => readerOk(state.native), io: state.io,
    });
    const owned = adapter.openRoot();
    if (!owned.ok) throw new TypeError(owned.code);

    // When: logical disposal precedes the owner's exact close.
    adapter.dispose();
    const before = state.libraryCloses();
    const blocked = [adapter.openRoot(), adapter.stat(owned.value), adapter.read(owned.value, 0, 1)];
    const closed = adapter.close(owned.value);
    const after = state.libraryCloses();
    const duplicate = adapter.close(owned.value);

    // Then: new work is blocked, ordinary close remains live, and FFI closes once only after fd drain.
    expect(before).toBe(0);
    expect(blocked).toEqual(Array.from({ length: 3 }, () => ({ ok: false, code: "reader_unavailable" })));
    expect({ closed, after, duplicate }).toEqual({
      closed: { ok: true, value: undefined }, after: 1, duplicate: { ok: false, code: "reader_unavailable" },
    });
  });

  test("provides an explicit unsupported adapter with no fallback operations", () => {
    // Given: the stable unsupported implementation.
    // When: every descriptor operation is attempted.
    const adapter = createUnsupportedAnchoredFsAdapter();

    // Then: it fails closed without exposing provider details.
    expect([adapter.openRoot(), adapter.stat(3), adapter.read(3, 0, 1), adapter.close(3)]).toEqual([
      { ok: false, code: "reader_unavailable" },
      { ok: false, code: "reader_unavailable" },
      { ok: false, code: "reader_unavailable" },
      { ok: false, code: "reader_unavailable" },
    ]);
  });
});
