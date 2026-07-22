import {
  readerError,
  readerOk,
  type AnchoredFsAdapter,
  type DescriptorKind,
  type DescriptorStat,
  type OpenAtRequest,
  type ReaderResult,
} from "../../src/anchored-fs";

export const mustReaderResult = <T>(result: ReaderResult<T>): T => {
  if (!result.ok) throw new TypeError(result.code);
  return result.value;
};

export type FakeNode = {
  kind: DescriptorKind | "symlink";
  readonly dev: bigint;
  readonly ino: bigint;
  nlink: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  data: Uint8Array;
  readonly entries: Map<string, FakeNode>;
};

type FakeHandle = { readonly node: FakeNode; closed: boolean };
type FakeBarrier = (event: string, adapter: FakeAnchoredFsAdapter) => void;

export class FakeAnchoredFsAdapter implements AnchoredFsAdapter {
  readonly available = true;
  readonly events: string[] = [];
  readonly root: FakeNode;
  private readonly handles = new Map<number, FakeHandle>();
  private readonly closes = new Map<number, number>();
  private nextFd = 10;
  private nextIno = 2n;
  private nextVersion = 1n;
  private barrier: FakeBarrier = () => undefined;
  private maxOpen = Number.POSITIVE_INFINITY;
  private physicallyDisposed = false;
  private disposeError: Error | undefined;
  disposed = false;

  constructor() {
    this.root = this.node("directory", new Uint8Array(), 1n);
  }

  setBarrier(barrier: FakeBarrier): void {
    this.barrier = barrier;
  }

  setMaxOpen(maxOpen: number): void {
    this.maxOpen = maxOpen;
  }

  addDirectory(path: string): FakeNode {
    let current = this.root;
    for (const component of this.components(path)) {
      const existing = current.entries.get(component);
      if (existing?.kind === "directory") {
        current = existing;
        continue;
      }
      const created = this.node("directory", new Uint8Array(), 1n);
      current.entries.set(component, created);
      current = created;
    }
    return current;
  }

  addFile(path: string, content: string, nlink = 1n): FakeNode {
    const created = this.node("regular", Buffer.from(content), nlink);
    this.put(path, created);
    return created;
  }

  addOther(path: string): FakeNode {
    const created = this.node("other", new Uint8Array(), 1n);
    this.put(path, created);
    return created;
  }

  addSymlink(path: string): FakeNode {
    const created = this.node("symlink", new Uint8Array(), 1n);
    this.put(path, created);
    return created;
  }

  alias(source: string, target: string): boolean {
    const node = this.nodeAt(source);
    if (!node) return false;
    this.put(target, node);
    return true;
  }

  replace(path: string, node: FakeNode): void {
    this.put(path, node);
  }

  nodeAt(path: string): FakeNode | undefined {
    let current: FakeNode | undefined = this.root;
    for (const component of this.components(path)) current = current?.entries.get(component);
    return current;
  }

  closeCount(fd: number): number {
    return this.closes.get(fd) ?? 0;
  }

  activeDescriptors(): number {
    return [...this.handles.values()].filter((handle) => !handle.closed).length;
  }

  descriptorLedger(): { readonly opened: number; readonly closeCalls: number; readonly active: number } {
    return Object.freeze({
      opened: this.handles.size,
      closeCalls: [...this.closes.values()].reduce((total, count) => total + count, 0),
      active: this.activeDescriptors(),
    });
  }

  setDisposeError(error: Error): void {
    this.disposeError = error;
  }

  openRoot(): ReaderResult<number> {
    if (this.disposed) return readerError("reader_unavailable");
    this.hit("open_root");
    return this.allocate(this.root);
  }

  openAt(request: OpenAtRequest): ReaderResult<number> {
    if (this.disposed) return readerError("reader_unavailable");
    this.hit(`before_open:${request.component}`);
    const parent = this.handles.get(request.parent);
    if (!parent || parent.closed || parent.node.kind !== "directory") return readerError("path_unavailable");
    const node = request.component === "." ? parent.node : parent.node.entries.get(request.component);
    if (!node || node.kind === "symlink") return readerError("path_unavailable");
    if (request.target === "directory" && node.kind !== "directory") return readerError("not_directory");
    const result = this.allocate(node);
    this.hit(`after_open:${request.component}`);
    return result;
  }

  stat(fd: number): ReaderResult<DescriptorStat> {
    if (this.disposed) return readerError("reader_unavailable");
    this.hit("before_stat");
    const handle = this.handles.get(fd);
    if (!handle || handle.closed || handle.node.kind === "symlink") return readerError("reader_unavailable");
    const stat = {
      dev: handle.node.dev,
      ino: handle.node.ino,
      nlink: handle.node.nlink,
      size: BigInt(handle.node.data.byteLength),
      mtimeNs: handle.node.mtimeNs,
      ctimeNs: handle.node.ctimeNs,
      kind: handle.node.kind,
    } as const;
    this.hit("after_stat");
    return readerOk(stat);
  }

  read(fd: number, offset: number, length: number): ReaderResult<Uint8Array> {
    if (this.disposed) return readerError("read_failed");
    this.hit("before_read");
    const handle = this.handles.get(fd);
    if (!handle || handle.closed || handle.node.kind !== "regular") return readerError("read_failed");
    this.hit("during_read");
    const bytes = handle.node.data.slice(offset, offset + length);
    this.hit("after_read");
    return readerOk(bytes);
  }

  close(fd: number): ReaderResult<undefined> {
    const handle = this.handles.get(fd);
    if (!handle || handle.closed) return readerError("reader_unavailable");
    handle.closed = true;
    this.closes.set(fd, (this.closes.get(fd) ?? 0) + 1);
    this.events.push(`close:${String(fd)}`);
    this.finishDispose();
    this.hit("after_close");
    return readerOk(undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.finishDispose();
    if (this.disposeError) throw this.disposeError;
  }

  private allocate(node: FakeNode): ReaderResult<number> {
    if (this.disposed) return readerError("reader_unavailable");
    if (this.activeDescriptors() >= this.maxOpen) return readerError("reader_unavailable");
    const fd = this.nextFd;
    this.nextFd += 1;
    this.handles.set(fd, { node, closed: false });
    this.events.push(`open:${String(fd)}:${node.kind}`);
    return readerOk(fd);
  }

  private node(kind: FakeNode["kind"], data: Uint8Array, nlink: bigint): FakeNode {
    const node = {
      kind,
      dev: 1n,
      ino: this.nextIno,
      nlink,
      mtimeNs: this.nextVersion,
      ctimeNs: this.nextVersion,
      data,
      entries: new Map<string, FakeNode>(),
    };
    this.nextIno += 1n;
    this.nextVersion += 1n;
    return node;
  }

  private put(path: string, node: FakeNode): void {
    const components = this.components(path);
    const name = components.pop();
    if (!name) return;
    const parent = this.addDirectory(`/${components.join("/")}`);
    parent.entries.set(name, node);
  }

  private components(path: string): string[] {
    return path.split("/").filter((component) => component.length > 0);
  }

  private hit(event: string): void {
    this.events.push(event);
    this.barrier(event, this);
  }

  private finishDispose(): void {
    if (!this.disposed || this.physicallyDisposed || this.activeDescriptors() > 0) return;
    this.physicallyDisposed = true;
    this.events.push("adapter_dispose");
  }
}
