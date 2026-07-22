import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin";
import {
  APPROVAL_AGENT_PROMPT_TOOLS,
  type ApprovalAgentRuntimeExpectation,
} from "./approval-agent";
import { createPosixAnchoredFsAdapter } from "./anchored-fs-posix";
import {
  canonicalRootSpelling,
  readerError,
  type AnchoredFsAdapter,
  type ReaderResult,
} from "./anchored-fs";
import {
  createApprovalReader,
  type ApprovalLeaseActivation,
  type ApprovalLeaseHandle,
  type ApprovalReader,
} from "./approval-reader";
import type { TempRootDefinition } from "./approval-reader-roots";
import { createOpenCodeClientAdapter } from "./opencode-client-adapter";
import type { ApprovalRootClient } from "./opencode-client-adapter";
import { createApprovalAgentConfigHook, type ExpectedApprovalAgent } from "./approval-plugin-agent";
import { createReviewRegistry } from "./review-registry";
import type { OpenCodeReviewerRuntime } from "./opencode-reviewer";
import { createConfirmationService, type ConfirmationService } from "./confirmation-service";
import type { ReviewConfig } from "./types";
export const APPROVAL_READ_TOOL_NAME = "opencode_smart_approval_read";
const READER_UNAVAILABLE_JSON = '{"ok":false,"error":"reader_unavailable"}';
const UNAUTHORIZED_JSON = '{"ok":false,"error":"unauthorized"}';
type ToolExecuteBefore = NonNullable<Hooks["tool.execute.before"]>;
export type ApprovalToolHookFactoryInput = {
  readonly directory: string;
  readonly reviewerRuntime: () => OpenCodeReviewerRuntime | undefined;
  readonly confirmationService: () => ConfirmationService | undefined;
};
export type ApprovalToolHookFactory = (input: ApprovalToolHookFactoryInput) => ToolExecuteBefore;
export type ApprovalPluginInput = {
  readonly directory: string;
  readonly client?: ApprovalRootClient;
  readonly project?: Pick<PluginInput["project"], "id">;
  readonly worktree?: string;
};
export type ApprovalHostEnvironment = {
  readonly XDG_DATA_HOME?: string;
};

export type ApprovalPluginIntegrationOptions = {
  readonly adapter?: AnchoredFsAdapter;
  readonly environment?: ApprovalHostEnvironment;
  readonly homeDirectory?: string;
  readonly tempDirectory?: string;
  readonly resolveRealPath?: (value: string) => string;
  readonly reviewConfig?: ReviewConfig;
  readonly createToolExecuteBefore: ApprovalToolHookFactory;
};

export type { ExpectedApprovalAgent } from "./approval-plugin-agent";

export type ApprovalPluginIntegration = {
  readonly hooks: Hooks;
  readonly promptTools: typeof APPROVAL_AGENT_PROMPT_TOOLS;
  activate(request: ApprovalLeaseActivation): ReaderResult<ApprovalLeaseHandle>;
  revoke(handle: ApprovalLeaseHandle): boolean;
  expectedAgent(): ExpectedApprovalAgent | undefined;
  reviewerRuntime(): OpenCodeReviewerRuntime | undefined;
};

const canonicalAbsolute = (value: string): string | undefined => {
  const canonical = canonicalRootSpelling(value);
  return canonical.ok ? canonical.value.absolute : undefined;
};

const runtimeExpectationFor = (
  environment: ApprovalHostEnvironment,
  homeDirectory: string,
): ApprovalAgentRuntimeExpectation | undefined => {
  const xdgData = environment.XDG_DATA_HOME || (homeDirectory ? join(homeDirectory, ".local", "share") : undefined);
  if (!xdgData || !isAbsolute(xdgData) || xdgData.includes("\0")) return undefined;
  return Object.freeze({ toolOutputGlob: join(xdgData, "opencode", "tool-output", "*") });
};

const processHostEnvironment = (): ApprovalHostEnvironment => {
  const xdgDataHome = process.env["XDG_DATA_HOME"];
  return xdgDataHome === undefined ? {} : { XDG_DATA_HOME: xdgDataHome };
};

const tempRootsFor = (
  worktree: string,
  workspace: string,
  temporary: string,
  resolveRealPath: (value: string) => string,
): readonly TempRootDefinition[] | undefined => {
  const lexicalTemporary = canonicalAbsolute(temporary);
  if (!lexicalTemporary) return undefined;
  let canonicalTemporary: string | undefined;
  try {
    canonicalTemporary = canonicalAbsolute(resolveRealPath(lexicalTemporary));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
  if (!canonicalTemporary) return undefined;
  const roots: TempRootDefinition[] = [{
    spelling: canonicalTemporary,
    verifiedAliases: canonicalTemporary === lexicalTemporary ? [] : [lexicalTemporary],
  }];
  if (worktree !== workspace && worktree !== canonicalTemporary) roots.push({ spelling: worktree });
  return Object.freeze(roots);
};

type ResolvedPluginRoots = {
  readonly workspace: string | undefined;
  readonly worktree: string | undefined;
};

const resolvePluginRoots = (input: ApprovalPluginInput): ResolvedPluginRoots => {
  const workspace = canonicalAbsolute(input.directory);
  const worktree = input.worktree === undefined ? workspace : canonicalAbsolute(input.worktree);
  return { workspace, worktree };
};

const readerFor = (
  roots: ResolvedPluginRoots,
  options: ApprovalPluginIntegrationOptions,
): { readonly reader?: ApprovalReader; readonly workspace?: string; readonly worktree?: string } => {
  const adapter = options.adapter ?? createPosixAnchoredFsAdapter();
  const resolveRealPath = options.resolveRealPath
    ?? (options.adapter ? ((value: string): string => value) : realpathSync);
  const { workspace, worktree } = roots;
  const tempRoots = workspace && worktree
    ? tempRootsFor(
      worktree,
      workspace,
      options.tempDirectory ?? tmpdir(),
      resolveRealPath,
    )
    : undefined;
  if (!workspace || !worktree || !tempRoots) {
    adapter.dispose();
    return {};
  }
  const created = createApprovalReader({ adapter, workspaceRoot: workspace, tempRoots });
  return created.ok ? { reader: created.value, workspace, worktree } : { workspace, worktree };
};

export const createApprovalPluginIntegration = (
  input: ApprovalPluginInput,
  options: ApprovalPluginIntegrationOptions,
): ApprovalPluginIntegration => {
  const initialized = readerFor(resolvePluginRoots(input), options);
  const runtimeExpectation = runtimeExpectationFor(
    options.environment ?? processHostEnvironment(),
    options.homeDirectory ?? homedir(),
  );
  let expected: ExpectedApprovalAgent | undefined;
  let disposed = false;
  let disposing = false;
  const rootClient = createOpenCodeClientAdapter(input.client);
  const registry = createReviewRegistry();
  const confirmation = input.client && initialized.workspace
    ? createConfirmationService({ adapter: rootClient, directory: initialized.workspace })
    : undefined;

  const reviewerRuntime = (): OpenCodeReviewerRuntime | undefined => {
    if (
      disposed ||
      disposing ||
      !input.client ||
      !input.project?.id ||
      !initialized.reader ||
      !initialized.workspace ||
      !initialized.worktree
    ) return undefined;
    return {
      adapter: rootClient,
      registry,
      projectID: input.project.id,
      directory: initialized.workspace,
      worktree: initialized.worktree,
      expectedAgent: () => expected,
      activate: (request) => initialized.reader?.activate(request) ?? readerError("reader_unavailable"),
      revoke: (handle) => !disposed && (initialized.reader?.revoke(handle) ?? false),
    };
  };
  const confirmationService = (): ConfirmationService | undefined => disposed || disposing ? undefined : confirmation;
  const unavailableToolExecuteBefore: ToolExecuteBefore = async () => {
    throw new Error("approval plugin roots are unavailable");
  };
  const toolExecuteBefore = initialized.reader && initialized.workspace
    ? options.createToolExecuteBefore({ directory: initialized.workspace, reviewerRuntime, confirmationService })
    : unavailableToolExecuteBefore;

  const readTool = tool({
    description: "Read one file through the active approval review lease.",
    args: {
      path: tool.schema.string().min(1),
      offset: tool.schema.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    },
    execute: async (args, context) => {
      if (disposed || disposing || !initialized.reader || !initialized.worktree) return READER_UNAVAILABLE_JSON;
      if (canonicalAbsolute(context.worktree) !== initialized.worktree) return UNAUTHORIZED_JSON;
      return initialized.reader.read(args, {
        sessionID: context.sessionID,
        agent: context.agent,
        directory: context.directory,
        abort: context.abort,
      });
    },
  });

  const hooks: Hooks = {
    config: createApprovalAgentConfigHook({
      reviewConfig: options.reviewConfig,
      runtime: runtimeExpectation,
      publish: (value) => { expected = value; },
    }),
    tool: { [APPROVAL_READ_TOOL_NAME]: readTool },
    "tool.execute.before": toolExecuteBefore,
    event: async ({ event }) => {
      if (disposed || disposing || !initialized.workspace) return;
      switch (event.type) {
        case "session.idle":
          await registry.idle(event.properties.sessionID, initialized.workspace);
          break;
        case "session.deleted":
          if (canonicalAbsolute(event.properties.info.directory) === initialized.workspace) {
            registry.deleted(event.properties.info.id, initialized.workspace);
            await confirmation?.clearSession(event.properties.info.id);
          }
          break;
        case "server.instance.disposed":
          if (canonicalAbsolute(event.properties.directory) === initialized.workspace) {
            await registry.dispose(initialized.workspace);
            await confirmation?.dispose();
          }
          break;
      }
    },
    dispose: async () => {
      if (disposed || disposing) return;
      disposing = true;
      if (initialized.workspace) await registry.dispose(initialized.workspace);
      await confirmation?.dispose();
      disposed = true;
      initialized.reader?.dispose();
    },
  };

  return Object.freeze({
    hooks,
    promptTools: APPROVAL_AGENT_PROMPT_TOOLS,
    activate: (request: ApprovalLeaseActivation) =>
      disposed || !initialized.reader
        ? readerError<ApprovalLeaseHandle>("reader_unavailable")
        : initialized.reader.activate(request),
    revoke: (handle: ApprovalLeaseHandle) => !disposed && initialized.reader !== undefined && initialized.reader.revoke(handle),
    expectedAgent: () => expected,
    reviewerRuntime,
  });
};
