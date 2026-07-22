import {
  MAX_APPROVAL_READ_BYTES,
  readerError,
  sameFileSnapshot,
  type AnchoredFile,
  type AnchoredFsAdapter,
  type ReaderErrorCode,
  type ReaderResult,
} from "./anchored-fs";

type ApprovalSnapshotRead = {
  readonly adapter: AnchoredFsAdapter;
  readonly file: AnchoredFile;
  readonly offset: number;
  readonly abort: AbortSignal;
  readonly current: () => boolean;
};

export const failureJson = (code: ReaderErrorCode): string => JSON.stringify({ ok: false, error: code });

export const successJson = (path: string, offset: number, bytes: Uint8Array): string => JSON.stringify({
  ok: true,
  path,
  offset,
  bytes: bytes.byteLength,
  content: Buffer.from(bytes).toString("utf8"),
});

export const readApprovalSnapshot = (request: ApprovalSnapshotRead): ReaderResult<Uint8Array> => {
  if (!request.current() || request.abort.aborted) return readerError("revoked");
  const before = request.adapter.stat(request.file.fd);
  if (!before.ok) return before;
  if (!sameFileSnapshot(request.file.stat, before.value)) return readerError("revoked");
  const bytes = request.adapter.read(request.file.fd, request.offset, MAX_APPROVAL_READ_BYTES);
  if (!bytes.ok) return bytes;
  if (!request.current() || request.abort.aborted) return readerError("revoked");
  const after = request.adapter.stat(request.file.fd);
  if (!after.ok) return after;
  if (!request.current() || request.abort.aborted || !sameFileSnapshot(request.file.stat, after.value)) {
    return readerError("revoked");
  }
  return bytes;
};

export const readApprovalWorkspace = (request: ApprovalSnapshotRead): ReaderResult<Uint8Array> => {
  let result = readerError<Uint8Array>("reader_unavailable");
  try {
    result = readApprovalSnapshot(request);
  } finally {
    try {
      const closed = request.adapter.close(request.file.fd);
      if (result.ok && !closed.ok) result = readerError("reader_unavailable");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (result.ok) result = readerError("reader_unavailable");
    }
  }
  return result;
};
