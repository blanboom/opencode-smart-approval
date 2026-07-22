import { readerError, type AnchoredFsAdapter, type OpenAtRequest, type ReaderResult } from "./anchored-fs";

const redactedResult = <T>(operation: () => ReaderResult<T>): ReaderResult<T> => {
  try {
    return operation();
  } catch (error) {
    if (error instanceof Error) return readerError("reader_unavailable");
    throw error;
  }
};

const redactedAvailable = (adapter: AnchoredFsAdapter): boolean => {
  try {
    return adapter.available;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
};

const redactedDispose = (adapter: AnchoredFsAdapter): void => {
  try {
    adapter.dispose();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
};

export const createRedactedApprovalAdapter = (adapter: AnchoredFsAdapter): AnchoredFsAdapter => Object.freeze({
  get available(): boolean {
    return redactedAvailable(adapter);
  },
  openRoot: (): ReaderResult<number> => redactedResult(() => adapter.openRoot()),
  openAt: (request: OpenAtRequest): ReaderResult<number> => redactedResult(() => adapter.openAt(request)),
  stat: (fd: number) => redactedResult(() => adapter.stat(fd)),
  read: (fd: number, offset: number, length: number) => redactedResult(() => adapter.read(fd, offset, length)),
  close: (fd: number) => redactedResult(() => adapter.close(fd)),
  dispose: (): void => redactedDispose(adapter),
});
