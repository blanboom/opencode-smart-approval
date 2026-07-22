import { z } from "zod";
import { APPROVAL_AGENT_NAME } from "./approval-agent";
import {
  duplicateAnchoredRoot,
  openAnchoredRegularFile,
  readerError,
  readerOk,
  sameFileSnapshot,
  type AnchoredFile,
  type ReaderResult,
} from "./anchored-fs";
import { absoluteStaticReference, authorizeAnchoredPath, type AuthorizedAnchoredPath } from "./approval-reader-paths";
import { failureJson, readApprovalSnapshot, readApprovalWorkspace, successJson } from "./approval-reader-read";
import { disposeApprovalRootSet, matchingTempRoot, type ApprovalRootSet } from "./approval-reader-roots";
import type {
  ApprovalLeaseActivation,
  ApprovalLeaseHandle,
  ApprovalReadContext,
  ApprovalReader,
} from "./approval-reader-types";

const ApprovalReadArgsSchema = z.strictObject({
  path: z.string().min(1),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});
const MAX_RETIRED_SESSION_IDS = 1_024;

type RetainedTemp = {
  readonly path: AuthorizedAnchoredPath;
  readonly file: AnchoredFile;
};

type ActiveLease = {
  readonly sessionID: string;
  readonly generation: number;
  readonly agent: string;
  readonly directory: string;
  readonly workspace: ApprovalRootSet["workspace"];
  readonly temp: ReadonlyMap<string, RetainedTemp>;
};

type ReadTarget =
  | { readonly kind: "temp"; readonly retained: RetainedTemp }
  | { readonly kind: "workspace"; readonly path: AuthorizedAnchoredPath };

class ActiveApprovalReader implements ApprovalReader {
  private readonly leases = new Map<string, ActiveLease>();
  private readonly retiredSessions = new Set<string>();
  private generation = 0;
  private disposed = false;

  constructor(private readonly roots: ApprovalRootSet) {}

  activate(request: ApprovalLeaseActivation): ReaderResult<ApprovalLeaseHandle> {
    try {
      return this.activateOwned(request);
    } catch (error) {
      if (error instanceof Error) return readerError("reader_unavailable");
      throw error;
    }
  }

  private activateOwned(request: ApprovalLeaseActivation): ReaderResult<ApprovalLeaseHandle> {
    if (
      this.disposed
      || request.sessionID.length === 0
      || request.agent !== APPROVAL_AGENT_NAME
      || request.directory !== this.roots.workspace.absolute
    ) return readerError("unauthorized");
    const existing = this.leases.get(request.sessionID);
    if (existing) {
      this.leases.delete(existing.sessionID);
      this.retire(existing.sessionID);
      if (!this.closeLease(existing)) return readerError("reader_unavailable");
    }
    const workspace = duplicateAnchoredRoot(this.roots.adapter, this.roots.workspace);
    if (!workspace.ok) return workspace;
    const temp = new Map<string, RetainedTemp>();
    let committed = false;
    try {
      for (const reference of request.references) {
        const absolute = absoluteStaticReference(reference);
        if (!absolute.ok) continue;
        const root = matchingTempRoot(this.roots, absolute.value);
        if (!root) continue;
        const path = authorizeAnchoredPath(root, absolute.value);
        if (!path.ok) continue;
        const file = openAnchoredRegularFile(this.roots.adapter, root, path.value.components);
        if (!file.ok) {
          if (file.code === "reader_unavailable") return readerError("reader_unavailable");
          continue;
        }
        const current = temp.get(path.value.absolute);
        if (current) {
          const closed = this.roots.adapter.close(file.value.fd);
          if (!closed.ok || !sameFileSnapshot(current.file.stat, file.value.stat)) {
            return readerError("reader_unavailable");
          }
          continue;
        }
        temp.set(path.value.absolute, Object.freeze({ path: path.value, file: file.value }));
      }
      if (this.generation >= Number.MAX_SAFE_INTEGER) return readerError("reader_unavailable");
      this.generation += 1;
      const lease = Object.freeze({
        sessionID: request.sessionID,
        generation: this.generation,
        agent: request.agent,
        directory: request.directory,
        workspace: workspace.value,
        temp,
      });
      this.leases.set(request.sessionID, lease);
      this.retiredSessions.delete(request.sessionID);
      committed = true;
      return readerOk(Object.freeze({ sessionID: lease.sessionID, generation: lease.generation }));
    } finally {
      if (!committed) this.closeDraft(workspace.value.fd, temp);
    }
  }

  read(input: unknown, context: ApprovalReadContext): string {
    try {
      return this.readAuthorized(input, context);
    } catch (error) {
      if (error instanceof Error) return failureJson("reader_unavailable");
      throw error;
    }
  }

  private readAuthorized(input: unknown, context: ApprovalReadContext): string {
    const args = ApprovalReadArgsSchema.safeParse(input);
    if (!args.success) return failureJson("invalid_arguments");
    const lease = this.leases.get(context.sessionID);
    if (!lease) return failureJson(this.retiredSessions.has(context.sessionID) ? "revoked" : "unauthorized");
    if (
      this.disposed
      || lease.agent !== context.agent
      || lease.directory !== context.directory
      || context.abort.aborted
    ) return failureJson("unauthorized");
    const target = this.targetFor(lease, args.data.path);
    if (!target.ok) return failureJson(target.code);
    let bytes: ReaderResult<Uint8Array>;
    switch (target.value.kind) {
      case "temp":
        bytes = readApprovalSnapshot({
          adapter: this.roots.adapter,
          file: target.value.retained.file,
          offset: args.data.offset,
          abort: context.abort,
          current: () => this.current(lease),
        });
        break;
      case "workspace": {
        const file = openAnchoredRegularFile(this.roots.adapter, lease.workspace, target.value.path.components);
        if (!file.ok) return failureJson(file.code);
        bytes = readApprovalWorkspace({
          adapter: this.roots.adapter,
          file: file.value,
          offset: args.data.offset,
          abort: context.abort,
          current: () => this.current(lease),
        });
        break;
      }
    }
    return bytes.ok ? successJson(args.data.path, args.data.offset, bytes.value) : failureJson(bytes.code);
  }

  revoke(handle: ApprovalLeaseHandle): boolean {
    try {
      const lease = this.leases.get(handle.sessionID);
      if (!lease || lease.generation !== handle.generation) return false;
      this.leases.delete(handle.sessionID);
      this.retire(handle.sessionID);
      this.closeLease(lease);
      return true;
    } catch (error) {
      if (error instanceof Error) return false;
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const active = [...this.leases.values()];
    this.leases.clear();
    this.retiredSessions.clear();
    for (const lease of active) this.closeLease(lease);
    disposeApprovalRootSet(this.roots);
  }

  private targetFor(lease: ActiveLease, request: string): ReaderResult<ReadTarget> {
    if (request.startsWith("/")) {
      const tempRoot = matchingTempRoot(this.roots, request);
      if (tempRoot) {
        const path = authorizeAnchoredPath(tempRoot, request);
        if (!path.ok) return path;
        const retained = lease.temp.get(path.value.absolute);
        return retained ? readerOk({ kind: "temp", retained }) : readerError("unauthorized");
      }
    }
    const path = authorizeAnchoredPath(lease.workspace, request);
    return path.ok ? readerOk({ kind: "workspace", path: path.value }) : path;
  }

  private current(lease: ActiveLease): boolean {
    const current = this.leases.get(lease.sessionID);
    return current === lease && current.generation === lease.generation;
  }

  private retire(sessionID: string): void {
    this.retiredSessions.delete(sessionID);
    this.retiredSessions.add(sessionID);
    while (this.retiredSessions.size > MAX_RETIRED_SESSION_IDS) {
      const oldest = this.retiredSessions.values().next().value;
      if (oldest === undefined) break;
      this.retiredSessions.delete(oldest);
    }
  }

  private closeDraft(workspaceFd: number, temp: ReadonlyMap<string, RetainedTemp>): boolean {
    let complete = true;
    for (const retained of temp.values()) {
      if (!this.roots.adapter.close(retained.file.fd).ok) complete = false;
    }
    if (!this.roots.adapter.close(workspaceFd).ok) complete = false;
    return complete;
  }

  private closeLease(lease: ActiveLease): boolean {
    return this.closeDraft(lease.workspace.fd, lease.temp);
  }
}

export const createActiveApprovalReader = (roots: ApprovalRootSet): ApprovalReader => new ActiveApprovalReader(roots);
