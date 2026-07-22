import {
  canonicalRootSpelling,
  openAnchoredRoot,
  readerError,
  readerOk,
  sameDescriptorIdentity,
  type AnchoredFsAdapter,
  type AnchoredRoot,
  type ReaderResult,
} from "./anchored-fs";

export type TempRootDefinition = {
  readonly spelling: string;
  readonly aliases?: readonly string[];
  readonly verifiedAliases?: readonly string[];
};

export type ApprovalRootOptions = {
  readonly adapter: AnchoredFsAdapter;
  readonly workspaceRoot: string;
  readonly tempRoots: readonly TempRootDefinition[];
};

export type ApprovalRootSet = {
  readonly adapter: AnchoredFsAdapter;
  readonly workspace: AnchoredRoot;
  readonly temp: ReadonlyMap<string, AnchoredRoot>;
  readonly owned: readonly AnchoredRoot[];
};

const closeOwnedRoots = (adapter: AnchoredFsAdapter, roots: readonly AnchoredRoot[]): void => {
  for (const root of [...roots].reverse()) adapter.close(root.fd);
};

const failedSetup = (
  adapter: AnchoredFsAdapter,
  slashFd: number | undefined,
  roots: readonly AnchoredRoot[],
): ReaderResult<ApprovalRootSet> => {
  closeOwnedRoots(adapter, roots);
  if (slashFd !== undefined) adapter.close(slashFd);
  adapter.dispose();
  return readerError<ApprovalRootSet>("reader_unavailable");
};

export const createApprovalRootSet = (options: ApprovalRootOptions): ReaderResult<ApprovalRootSet> => {
  const { adapter } = options;
  if (!adapter.available) {
    adapter.dispose();
    return readerError("reader_unavailable");
  }
  const slash = adapter.openRoot();
  if (!slash.ok) {
    adapter.dispose();
    return readerError("reader_unavailable");
  }
  const owned: AnchoredRoot[] = [];
  const views = new Map<string, AnchoredRoot>();
  const openView = (spelling: string): ReaderResult<AnchoredRoot> => {
    const canonical = canonicalRootSpelling(spelling);
    if (!canonical.ok) return canonical;
    const existingView = views.get(canonical.value.absolute);
    if (existingView) return readerOk(existingView);
    const opened = openAnchoredRoot(adapter, slash.value, canonical.value);
    if (!opened.ok) return opened;
    const identity = owned.find((candidate) => sameDescriptorIdentity(candidate.stat, opened.value.stat));
    if (identity) {
      const closed = adapter.close(opened.value.fd);
      if (!closed.ok) return readerError("reader_unavailable");
      const view = Object.freeze({ ...opened.value, fd: identity.fd, stat: identity.stat });
      views.set(view.absolute, view);
      return readerOk(view);
    }
    owned.push(opened.value);
    views.set(opened.value.absolute, opened.value);
    return readerOk(opened.value);
  };
  try {
    const workspace = openView(options.workspaceRoot);
    if (!workspace.ok) return failedSetup(adapter, slash.value, owned);
    const temp = new Map<string, AnchoredRoot>();
    for (const definition of options.tempRoots) {
      const primary = openView(definition.spelling);
      if (!primary.ok) return failedSetup(adapter, slash.value, owned);
      temp.set(primary.value.absolute, primary.value);
      for (const alias of definition.aliases ?? []) {
        const view = openView(alias);
        if (!view.ok || !sameDescriptorIdentity(primary.value.stat, view.value.stat)) {
          return failedSetup(adapter, slash.value, owned);
        }
        temp.set(view.value.absolute, view.value);
      }
      for (const alias of definition.verifiedAliases ?? []) {
        const canonical = canonicalRootSpelling(alias);
        if (!canonical.ok) return failedSetup(adapter, slash.value, owned);
        const existing = views.get(canonical.value.absolute);
        if (existing && !sameDescriptorIdentity(primary.value.stat, existing.stat)) {
          return failedSetup(adapter, slash.value, owned);
        }
        const view = existing ?? Object.freeze({
          ...primary.value,
          absolute: canonical.value.absolute,
          components: canonical.value.components,
        });
        views.set(view.absolute, view);
        temp.set(view.absolute, view);
      }
    }
    const slashClosed = adapter.close(slash.value);
    if (!slashClosed.ok) return failedSetup(adapter, undefined, owned);
    return readerOk(Object.freeze({ adapter, workspace: workspace.value, temp, owned: Object.freeze(owned) }));
  } catch (error) {
    if (error instanceof Error) return failedSetup(adapter, slash.value, owned);
    throw error;
  }
};

export const disposeApprovalRootSet = (roots: ApprovalRootSet): void => {
  closeOwnedRoots(roots.adapter, roots.owned);
  roots.adapter.dispose();
};

export const matchingTempRoot = (roots: ApprovalRootSet, absolute: string): AnchoredRoot | undefined =>
  [...roots.temp.values()]
    .sort((left, right) => right.absolute.length - left.absolute.length)
    .find((root) => absolute.startsWith(root.absolute === "/" ? "/" : `${root.absolute}/`));
