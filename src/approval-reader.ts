import { createRedactedApprovalAdapter } from "./approval-reader-adapter";
import {
  readerError,
  readerOk,
  type AnchoredFsAdapter,
  type ReaderResult,
} from "./anchored-fs";
import { createActiveApprovalReader } from "./approval-reader-active";
import {
  createApprovalRootSet,
  type ApprovalRootOptions,
} from "./approval-reader-roots";
import type { ApprovalReader } from "./approval-reader-types";

export type {
  ApprovalLeaseActivation,
  ApprovalLeaseHandle,
  ApprovalReadContext,
  ApprovalReader,
} from "./approval-reader-types";

export const createApprovalReader = (options: ApprovalRootOptions): ReaderResult<ApprovalReader> => {
  let adapter: AnchoredFsAdapter | undefined;
  try {
    adapter = createRedactedApprovalAdapter(options.adapter);
    const roots = createApprovalRootSet({
      adapter,
      workspaceRoot: options.workspaceRoot,
      tempRoots: options.tempRoots,
    });
    return roots.ok ? readerOk(createActiveApprovalReader(roots.value)) : roots;
  } catch (error) {
    if (error instanceof Error) {
      adapter?.dispose();
      return readerError("reader_unavailable");
    }
    throw error;
  }
};
