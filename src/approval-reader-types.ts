import type { ReaderResult } from "./anchored-fs";
import type { StaticFileReference } from "./types";

export type ApprovalReadContext = {
  readonly sessionID: string;
  readonly agent: string;
  readonly directory: string;
  readonly abort: AbortSignal;
};

export type ApprovalLeaseActivation = {
  readonly sessionID: string;
  readonly agent: string;
  readonly directory: string;
  readonly references: readonly StaticFileReference[];
};

export type ApprovalLeaseHandle = {
  readonly sessionID: string;
  readonly generation: number;
};

export interface ApprovalReader {
  activate(request: ApprovalLeaseActivation): ReaderResult<ApprovalLeaseHandle>;
  read(args: unknown, context: ApprovalReadContext): string;
  revoke(handle: ApprovalLeaseHandle): boolean;
  dispose(): void;
}
