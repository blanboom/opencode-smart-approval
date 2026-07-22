export const MAX_APPROVAL_READ_BYTES = 65_536;

export type ReaderErrorCode =
  | "reader_unavailable"
  | "invalid_path"
  | "path_unavailable"
  | "not_directory"
  | "not_regular"
  | "hardlink"
  | "read_failed"
  | "invalid_arguments"
  | "sensitive_path"
  | "unauthorized"
  | "revoked";

export type ReaderResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ReaderErrorCode };

export type DescriptorKind = "directory" | "regular" | "other";

export type DescriptorStat = {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly kind: DescriptorKind;
};

export type OpenAtRequest = {
  readonly parent: number;
  readonly component: string;
  readonly target: "directory" | "file";
};

export interface AnchoredFsAdapter {
  readonly available: boolean;
  openRoot(): ReaderResult<number>;
  openAt(request: OpenAtRequest): ReaderResult<number>;
  stat(fd: number): ReaderResult<DescriptorStat>;
  read(fd: number, offset: number, length: number): ReaderResult<Uint8Array>;
  close(fd: number): ReaderResult<undefined>;
  dispose(): void;
}

export type CanonicalRoot = {
  readonly absolute: string;
  readonly components: readonly string[];
};

export type AnchoredRoot = CanonicalRoot & {
  readonly fd: number;
  readonly stat: DescriptorStat;
};

export type AnchoredFile = {
  readonly fd: number;
  readonly stat: DescriptorStat;
};

export const readerOk = <T>(value: T): ReaderResult<T> => ({ ok: true, value });
export const readerError = <T>(code: ReaderErrorCode): ReaderResult<T> => ({ ok: false, code });

const frozenStat = (stat: DescriptorStat): DescriptorStat => Object.freeze({ ...stat });

const validComponent = (component: string): boolean =>
  component.length > 0 && component !== "." && component !== ".." && !component.includes("\0") && !component.includes("/");

export const canonicalRootSpelling = (value: string): ReaderResult<CanonicalRoot> => {
  if (!value.startsWith("/") || value.includes("\0")) return readerError("invalid_path");
  const components: string[] = [];
  for (const component of value.split("/")) {
    if (component.length === 0 || component === ".") continue;
    if (component === "..") {
      components.pop();
      continue;
    }
    if (!validComponent(component)) return readerError("invalid_path");
    components.push(component);
  }
  const frozen = Object.freeze(components);
  return readerOk(Object.freeze({ absolute: frozen.length === 0 ? "/" : `/${frozen.join("/")}`, components: frozen }));
};

export const relativePathComponents = (value: string): ReaderResult<readonly string[]> => {
  if (value.length === 0 || value.startsWith("/") || value.endsWith("/") || value.includes("//")) {
    return readerError("invalid_path");
  }
  const components = value.split("/");
  if (!components.every(validComponent)) return readerError("invalid_path");
  return readerOk(Object.freeze(components));
};

export const sameDescriptorIdentity = (left: DescriptorStat, right: DescriptorStat): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.kind === right.kind;

export const sameFileSnapshot = (left: DescriptorStat, right: DescriptorStat): boolean =>
  sameDescriptorIdentity(left, right)
  && right.kind === "regular"
  && left.nlink === 1n
  && right.nlink === 1n
  && left.size === right.size
  && left.mtimeNs === right.mtimeNs
  && left.ctimeNs === right.ctimeNs;

const closeFailure = (adapter: AnchoredFsAdapter, fd: number): ReaderErrorCode | undefined => {
  const result = adapter.close(fd);
  return result.ok ? undefined : result.code;
};

const closeBeforeError = <T>(adapter: AnchoredFsAdapter, fd: number, code: ReaderErrorCode): ReaderResult<T> =>
  readerError(closeFailure(adapter, fd) ?? code);

export const openAnchoredRoot = (
  adapter: AnchoredFsAdapter,
  slashFd: number,
  root: CanonicalRoot,
): ReaderResult<AnchoredRoot> => {
  let current = slashFd;
  let owned = false;
  const components = root.components.length === 0 ? ["."] : root.components;
  for (const component of components) {
    const opened = adapter.openAt({ parent: current, component, target: "directory" });
    if (!opened.ok) return owned ? closeBeforeError(adapter, current, opened.code) : opened;
    if (owned) {
      const closeCode = closeFailure(adapter, current);
      if (closeCode) return closeBeforeError(adapter, opened.value, closeCode);
    }
    current = opened.value;
    owned = true;
  }
  const stat = adapter.stat(current);
  if (!stat.ok) return closeBeforeError(adapter, current, stat.code);
  if (stat.value.kind !== "directory") return closeBeforeError(adapter, current, "not_directory");
  return readerOk(Object.freeze({ ...root, fd: current, stat: frozenStat(stat.value) }));
};

export const duplicateAnchoredRoot = (
  adapter: AnchoredFsAdapter,
  root: AnchoredRoot,
): ReaderResult<AnchoredRoot> => {
  const opened = adapter.openAt({ parent: root.fd, component: ".", target: "directory" });
  if (!opened.ok) return opened;
  const stat = adapter.stat(opened.value);
  if (!stat.ok) return closeBeforeError(adapter, opened.value, stat.code);
  if (!sameDescriptorIdentity(root.stat, stat.value)) return closeBeforeError(adapter, opened.value, "not_directory");
  return readerOk(Object.freeze({ ...root, fd: opened.value, stat: frozenStat(stat.value) }));
};

export const openAnchoredRegularFile = (
  adapter: AnchoredFsAdapter,
  root: AnchoredRoot,
  components: readonly string[],
): ReaderResult<AnchoredFile> => {
  if (components.length === 0 || !components.every(validComponent)) return readerError("invalid_path");
  let current = root.fd;
  let owned = false;
  for (const component of components.slice(0, -1)) {
    const opened = adapter.openAt({ parent: current, component, target: "directory" });
    if (!opened.ok) return owned ? closeBeforeError(adapter, current, opened.code) : opened;
    if (owned) {
      const closeCode = closeFailure(adapter, current);
      if (closeCode) return closeBeforeError(adapter, opened.value, closeCode);
    }
    current = opened.value;
    owned = true;
  }
  const final = components.at(-1);
  if (!final) return readerError("invalid_path");
  const opened = adapter.openAt({ parent: current, component: final, target: "file" });
  if (owned) {
    const closeCode = closeFailure(adapter, current);
    if (closeCode) return opened.ok ? closeBeforeError(adapter, opened.value, closeCode) : readerError(closeCode);
  }
  if (!opened.ok) return opened;
  const stat = adapter.stat(opened.value);
  if (!stat.ok) return closeBeforeError(adapter, opened.value, stat.code);
  if (stat.value.kind !== "regular") return closeBeforeError(adapter, opened.value, "not_regular");
  if (stat.value.nlink !== 1n) return closeBeforeError(adapter, opened.value, "hardlink");
  return readerOk(Object.freeze({ fd: opened.value, stat: frozenStat(stat.value) }));
};
