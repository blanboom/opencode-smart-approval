import { closeSync, fstatSync, readSync } from "node:fs";
import { dlopen } from "bun:ffi";
import {
  readerError,
  readerOk,
  sameDescriptorIdentity,
  type AnchoredFsAdapter,
  type DescriptorStat,
  type OpenAtRequest,
  type ReaderResult,
} from "./anchored-fs";
import { createUnsupportedAnchoredFsAdapter } from "./anchored-fs-unsupported";

const DARWIN_DIRECTORY_FLAGS = 0x0110_0100;
const DARWIN_FILE_FLAGS = 0x0100_0104;
const LINUX_DIRECTORY_FLAGS = 0x000b_0000;
const LINUX_FILE_FLAGS = 0x000a_0800;

export const POSIX_TARGETS = Object.freeze({
  darwin: Object.freeze({
    library: "/usr/lib/libSystem.B.dylib",
    directoryFlags: DARWIN_DIRECTORY_FLAGS,
    fileFlags: DARWIN_FILE_FLAGS,
  }),
  linux: Object.freeze({ library: "libc.so.6", directoryFlags: LINUX_DIRECTORY_FLAGS, fileFlags: LINUX_FILE_FLAGS }),
});

export type PosixNative = {
  readonly open: (path: Uint8Array, flags: number) => number;
  readonly openAt: (parent: number, path: Uint8Array, flags: number) => number;
  readonly closeLibrary: () => void;
};

export type PosixIo = {
  readonly stat: (fd: number) => ReaderResult<DescriptorStat>;
  readonly read: (fd: number, offset: number, length: number) => ReaderResult<Uint8Array>;
  readonly close: (fd: number) => ReaderResult<undefined>;
};

export type PosixNativeLoader = (library: string) => ReaderResult<PosixNative>;

export type PosixAdapterOptions = {
  readonly platform?: NodeJS.Platform;
  readonly nativeLoader?: PosixNativeLoader;
  readonly io?: PosixIo;
};

const cString = (value: string): Uint8Array => Buffer.from(`${value}\0`, "utf8");

const defaultNativeLoader: PosixNativeLoader = (name) => {
  try {
    const library = dlopen(name, {
      open: { args: ["ptr", "i32"], returns: "i32" },
      openat: { args: ["i32", "ptr", "i32"], returns: "i32" },
    });
    return readerOk({
      open: (path, flags) => library.symbols.open(path, flags),
      openAt: (parent, path, flags) => library.symbols.openat(parent, path, flags),
      closeLibrary: () => library.close(),
    });
  } catch (error) {
    if (error instanceof Error) return readerError("reader_unavailable");
    throw error;
  }
};

const defaultIo: PosixIo = Object.freeze({
  stat: (fd) => {
    try {
      const stat = fstatSync(fd, { bigint: true });
      return readerOk({
        dev: stat.dev,
        ino: stat.ino,
        nlink: stat.nlink,
        size: stat.size,
        mtimeNs: stat.mtimeNs,
        ctimeNs: stat.ctimeNs,
        kind: stat.isDirectory() ? "directory" : stat.isFile() ? "regular" : "other",
      });
    } catch (error) {
      if (error instanceof Error) return readerError("reader_unavailable");
      throw error;
    }
  },
  read: (fd, offset, length) => {
    try {
      const buffer = Buffer.alloc(length);
      let total = 0;
      while (total < length) {
        const count = readSync(fd, buffer, total, length - total, offset + total);
        if (count === 0) break;
        total += count;
      }
      return readerOk(buffer.subarray(0, total));
    } catch (error) {
      if (error instanceof Error) return readerError("read_failed");
      throw error;
    }
  },
  close: (fd) => {
    try {
      closeSync(fd);
      return readerOk(undefined);
    } catch (error) {
      if (error instanceof Error) return readerError("reader_unavailable");
      throw error;
    }
  },
});

type PosixTarget = (typeof POSIX_TARGETS)[keyof typeof POSIX_TARGETS];

const stableResult = <T>(operation: () => ReaderResult<T>, code: "reader_unavailable" | "read_failed"): ReaderResult<T> => {
  try {
    return operation();
  } catch (error) {
    if (error instanceof Error) return readerError(code);
    throw error;
  }
};

class PosixAnchoredFsAdapter implements AnchoredFsAdapter {
  readonly available = true;
  private readonly descriptors = new Set<number>();
  private disposed = false;
  private libraryClosed = false;

  constructor(
    private readonly native: PosixNative,
    private readonly io: PosixIo,
    private readonly target: PosixTarget,
  ) {}

  openRoot(): ReaderResult<number> {
    if (this.disposed) return readerError("reader_unavailable");
    return this.nativeOpen(() => this.native.open(cString("/"), this.target.directoryFlags));
  }

  openAt(request: OpenAtRequest): ReaderResult<number> {
    if (this.disposed) return readerError("reader_unavailable");
    if (request.component.length === 0 || request.component.includes("\0") || request.component.includes("/")) {
      return readerError("invalid_path");
    }
    const flags = request.target === "directory" ? this.target.directoryFlags : this.target.fileFlags;
    return this.nativeOpen(() => this.native.openAt(request.parent, cString(request.component), flags));
  }

  stat(fd: number): ReaderResult<DescriptorStat> {
    return this.disposed ? readerError("reader_unavailable") : stableResult(() => this.io.stat(fd), "reader_unavailable");
  }

  read(fd: number, offset: number, length: number): ReaderResult<Uint8Array> {
    return this.disposed ? readerError("reader_unavailable") : stableResult(() => this.io.read(fd, offset, length), "read_failed");
  }

  close(fd: number): ReaderResult<undefined> {
    if (!this.descriptors.has(fd)) return readerError("reader_unavailable");
    const result = stableResult(() => this.io.close(fd), "reader_unavailable");
    if (result.ok) {
      this.descriptors.delete(fd);
      this.finishDispose();
    }
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.finishDispose();
  }

  private finishDispose(): void {
    if (!this.disposed || this.libraryClosed || this.descriptors.size > 0) return;
    this.libraryClosed = true;
    try {
      this.native.closeLibrary();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
  }

  private nativeOpen(operation: () => number): ReaderResult<number> {
    try {
      const fd = operation();
      if (fd < 0) return readerError("path_unavailable");
      this.descriptors.add(fd);
      return readerOk(fd);
    } catch (error) {
      if (error instanceof Error) return readerError("reader_unavailable");
      throw error;
    }
  }
}

const targetFor = (platform: NodeJS.Platform): PosixTarget | undefined =>
  platform === "darwin" ? POSIX_TARGETS.darwin : platform === "linux" ? POSIX_TARGETS.linux : undefined;

const failedStartup = (adapter: PosixAnchoredFsAdapter, descriptors: readonly number[]): AnchoredFsAdapter => {
  for (const fd of descriptors) adapter.close(fd);
  adapter.dispose();
  return createUnsupportedAnchoredFsAdapter();
};

export const createPosixAnchoredFsAdapter = (options: PosixAdapterOptions = {}): AnchoredFsAdapter => {
  const target = targetFor(options.platform ?? process.platform);
  if (!target) return createUnsupportedAnchoredFsAdapter();
  const loader = options.nativeLoader ?? defaultNativeLoader;
  const loaded = stableResult(() => loader(target.library), "reader_unavailable");
  if (!loaded.ok) return createUnsupportedAnchoredFsAdapter();
  const adapter = new PosixAnchoredFsAdapter(loaded.value, options.io ?? defaultIo, target);
  const slash = adapter.openRoot();
  if (!slash.ok) return failedStartup(adapter, []);
  const slashStat = adapter.stat(slash.value);
  if (!slashStat.ok || slashStat.value.kind !== "directory") return failedStartup(adapter, [slash.value]);
  const duplicate = adapter.openAt({ parent: slash.value, component: ".", target: "directory" });
  if (!duplicate.ok) return failedStartup(adapter, [slash.value]);
  const duplicateStat = adapter.stat(duplicate.value);
  if (!duplicateStat.ok || !sameDescriptorIdentity(slashStat.value, duplicateStat.value)) {
    return failedStartup(adapter, [duplicate.value, slash.value]);
  }
  const duplicateClosed = adapter.close(duplicate.value);
  const slashClosed = adapter.close(slash.value);
  if (!duplicateClosed.ok || !slashClosed.ok) return failedStartup(adapter, []);
  return adapter;
};
