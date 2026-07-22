import { APPROVAL_AGENT_NAME } from "../../src/approval-agent";
import { validCreatedSession } from "./opencode-review-fixtures";
import { MALFORMED_OWNERSHIP_SESSION_CASES } from "./opencode-session-ownership-fixtures";
export const validSourceCreatedSession = () => ({
  ...validCreatedSession(),
  slug: "review-child",
  workspaceID: "wrk_workspace",
  path: ".",
  summary: {
    additions: 1,
    deletions: 0,
    files: 1,
    diffs: [{ file: "script.sh", patch: "@@ -1 +1 @@", additions: 1, deletions: 0, status: "modified" }],
  },
  cost: 0.25,
  tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 4, write: 5 } },
  share: { url: "https://example.invalid/session/child-session" },
  agent: APPROVAL_AGENT_NAME,
  model: { id: "reviewer-model", providerID: "reviewer-provider", variant: "secure" },
  metadata: { purpose: "approval", nested: { trusted: false } },
  time: { created: 10, updated: 11, compacting: 0, archived: -1 },
  permission: [{ permission: "opencode_smart_approval_read", pattern: "*", action: "allow" }],
  revert: { messageID: "msg_review", partID: "prt_review", snapshot: "snapshot", diff: "diff" },
});

export const validSourceSessionCases = () => [
  ["required fields", { ...validCreatedSession(), slug: "review-child" }],
  ["all optional fields", validSourceCreatedSession()],
  ["summary without diffs", { ...validSourceCreatedSession(), summary: { additions: -0.5, deletions: 0.5, files: 0 } }],
  ["diff optional fields omitted", {
    ...validSourceCreatedSession(),
    summary: { additions: 0, deletions: 0, files: 0, diffs: [{ additions: 0, deletions: 0 }] },
  }],
  ["revert optional fields omitted", { ...validSourceCreatedSession(), revert: { messageID: "msg_review" } }],
  ["model variant omitted", {
    ...validSourceCreatedSession(), model: { id: "reviewer-model", providerID: "reviewer-provider" },
  }],
  ["empty permission rules", { ...validSourceCreatedSession(), permission: [] }],
  ["branded prefix boundaries", {
    ...validSourceCreatedSession(), workspaceID: "wrk", revert: { messageID: "msg", partID: "prt" },
  }],
  ["all permission actions", {
    ...validSourceCreatedSession(),
    permission: ["allow", "deny", "ask"].map((action) => ({ permission: "read", pattern: "*", action })),
  }],
  ["all diff statuses", {
    ...validSourceCreatedSession(),
    summary: {
      additions: 0, deletions: 0, files: 0,
      diffs: ["added", "deleted", "modified"].map((status) => ({ additions: 0, deletions: 0, status })),
    },
  }],
  ["empty source strings", {
    ...validSourceCreatedSession(), slug: "", path: "", agent: "", share: { url: "" },
  }],
] as const;

type SourceSession = ReturnType<typeof validSourceCreatedSession>;

export type MalformedSourceSessionCase = {
  readonly label: string;
  readonly mutate: (session: SourceSession) => unknown;
};

const MALFORMED_SESSION_FIELD_CASES: MalformedSourceSessionCase[] = [
  { label: "slug type", mutate: (session) => ({ ...session, slug: 1 }) },
  { label: "missing slug", mutate: (session) => { const { slug: _slug, ...input } = session; return input; } },
  { label: "project type", mutate: (session) => ({ ...session, projectID: 1 }) },
  { label: "missing project", mutate: (session) => ({ ...session, projectID: undefined }) },
  { label: "project mismatch", mutate: (session) => ({ ...session, projectID: "other" }) },
  { label: "workspace type", mutate: (session) => ({ ...session, workspaceID: 1 }) },
  { label: "workspace prefix", mutate: (session) => ({ ...session, workspaceID: "workspace-id" }) },
  { label: "directory type", mutate: (session) => ({ ...session, directory: 1 }) },
  { label: "missing directory", mutate: (session) => ({ ...session, directory: undefined }) },
  { label: "directory mismatch", mutate: (session) => ({ ...session, directory: "/other" }) },
  { label: "path type", mutate: (session) => ({ ...session, path: 1 }) },
  { label: "parent type", mutate: (session) => ({ ...session, parentID: 1 }) },
  { label: "missing parent", mutate: (session) => ({ ...session, parentID: undefined }) },
  { label: "parent mismatch", mutate: (session) => ({ ...session, parentID: "other" }) },
  { label: "summary type", mutate: (session) => ({ ...session, summary: [] }) },
  { label: "summary missing additions", mutate: (session) => ({
    ...session, summary: { deletions: 0, files: 1, diffs: session.summary.diffs },
  }) },
  { label: "summary additions nonfinite", mutate: (session) => ({
    ...session, summary: { ...session.summary, additions: Number.NaN },
  }) },
  { label: "summary additions type", mutate: (session) => ({
    ...session, summary: { ...session.summary, additions: "1" },
  }) },
  { label: "summary missing deletions", mutate: (session) => ({
    ...session, summary: { ...session.summary, deletions: undefined },
  }) },
  { label: "summary deletions type", mutate: (session) => ({
    ...session, summary: { ...session.summary, deletions: "0" },
  }) },
  { label: "summary deletions nonfinite", mutate: (session) => ({
    ...session, summary: { ...session.summary, deletions: Number.NEGATIVE_INFINITY },
  }) },
  { label: "summary missing files", mutate: (session) => ({
    ...session, summary: { ...session.summary, files: undefined },
  }) },
  { label: "summary files type", mutate: (session) => ({
    ...session, summary: { ...session.summary, files: "1" },
  }) },
  { label: "summary files nonfinite", mutate: (session) => ({
    ...session, summary: { ...session.summary, files: Number.POSITIVE_INFINITY },
  }) },
  { label: "summary diffs type", mutate: (session) => ({ ...session, summary: { ...session.summary, diffs: {} } }) },
  { label: "summary diff missing additions", mutate: (session) => ({
    ...session, summary: { ...session.summary, diffs: [{ deletions: 0 }] },
  }) },
  { label: "summary diff additions type", mutate: (session) => ({
    ...session, summary: { ...session.summary, diffs: [{ additions: "0", deletions: 0 }] },
  }) },
  { label: "summary diff additions nonfinite", mutate: (session) => ({
    ...session, summary: { ...session.summary, diffs: [{ additions: Number.NaN, deletions: 0 }] },
  }) },
  { label: "summary diff missing deletions", mutate: (session) => ({
    ...session, summary: { ...session.summary, diffs: [{ additions: 0 }] },
  }) },
  { label: "summary diff deletions type", mutate: (session) => ({
    ...session, summary: { ...session.summary, diffs: [{ additions: 0, deletions: "0" }] },
  }) },
  { label: "summary diff deletions nonfinite", mutate: (session) => ({
    ...session, summary: { ...session.summary, diffs: [{ additions: 0, deletions: Number.NaN }] },
  }) },
  { label: "summary diff file type", mutate: (session) => ({
    ...session, summary: { ...session.summary, diffs: [{ additions: 0, deletions: 0, file: 1 }] },
  }) },
  { label: "summary diff patch type", mutate: (session) => ({
    ...session, summary: { ...session.summary, diffs: [{ additions: 0, deletions: 0, patch: 1 }] },
  }) },
  { label: "summary diff status", mutate: (session) => ({
    ...session, summary: { ...session.summary, diffs: [{ additions: 0, deletions: 0, status: "renamed" }] },
  }) },
  { label: "summary diff unknown", mutate: (session) => ({
    ...session, summary: { ...session.summary, diffs: [{ additions: 0, deletions: 0, unexpected: true }] },
  }) },
  { label: "summary unknown", mutate: (session) => ({ ...session, summary: { ...session.summary, unexpected: true } }) },
  { label: "cost type", mutate: (session) => ({ ...session, cost: "0.25" }) },
  { label: "cost nonfinite", mutate: (session) => ({ ...session, cost: Number.NaN }) },
  { label: "tokens type", mutate: (session) => ({ ...session, tokens: [] }) },
  { label: "tokens missing input", mutate: (session) => ({
    ...session, tokens: { ...session.tokens, input: undefined },
  }) },
  { label: "tokens input type", mutate: (session) => ({ ...session, tokens: { ...session.tokens, input: "2" } }) },
  { label: "tokens input nonfinite", mutate: (session) => ({ ...session, tokens: { ...session.tokens, input: Number.NaN } }) },
  { label: "tokens missing output", mutate: (session) => ({
    ...session, tokens: { ...session.tokens, output: undefined },
  }) },
  { label: "tokens output type", mutate: (session) => ({ ...session, tokens: { ...session.tokens, output: "3" } }) },
  { label: "tokens output nonfinite", mutate: (session) => ({
    ...session, tokens: { ...session.tokens, output: Number.POSITIVE_INFINITY },
  }) },
  { label: "tokens missing reasoning", mutate: (session) => ({
    ...session, tokens: { input: 2, output: 3, cache: session.tokens.cache },
  }) },
  { label: "tokens reasoning type", mutate: (session) => ({
    ...session, tokens: { ...session.tokens, reasoning: "1" },
  }) },
  { label: "tokens reasoning nonfinite", mutate: (session) => ({
    ...session, tokens: { ...session.tokens, reasoning: Number.NaN },
  }) },
  { label: "tokens missing cache", mutate: (session) => ({
    ...session, tokens: { ...session.tokens, cache: undefined },
  }) },
  { label: "tokens cache type", mutate: (session) => ({ ...session, tokens: { ...session.tokens, cache: [] } }) },
  { label: "tokens cache missing read", mutate: (session) => ({
    ...session, tokens: { ...session.tokens, cache: { ...session.tokens.cache, read: undefined } },
  }) },
  { label: "tokens cache read type", mutate: (session) => ({
    ...session, tokens: { ...session.tokens, cache: { ...session.tokens.cache, read: "4" } },
  }) },
  { label: "tokens cache read nonfinite", mutate: (session) => ({
    ...session, tokens: { ...session.tokens, cache: { ...session.tokens.cache, read: Number.NEGATIVE_INFINITY } },
  }) },
  { label: "tokens cache write type", mutate: (session) => ({
    ...session, tokens: { ...session.tokens, cache: { ...session.tokens.cache, write: "5" } },
  }) },
  { label: "tokens cache missing write", mutate: (session) => ({
    ...session, tokens: { ...session.tokens, cache: { ...session.tokens.cache, write: undefined } },
  }) },
  { label: "tokens cache write nonfinite", mutate: (session) => ({
    ...session, tokens: { ...session.tokens, cache: { ...session.tokens.cache, write: Number.NaN } },
  }) },
  { label: "tokens cache unknown", mutate: (session) => ({
    ...session, tokens: { ...session.tokens, cache: { ...session.tokens.cache, unexpected: true } },
  }) },
  { label: "tokens unknown", mutate: (session) => ({ ...session, tokens: { ...session.tokens, unexpected: true } }) },
  { label: "share type", mutate: (session) => ({ ...session, share: [] }) },
  { label: "share missing url", mutate: (session) => ({ ...session, share: {} }) },
  { label: "share url type", mutate: (session) => ({ ...session, share: { url: 1 } }) },
  { label: "share unknown", mutate: (session) => ({ ...session, share: { ...session.share, unexpected: true } }) },
  { label: "missing title", mutate: (session) => ({ ...session, title: undefined }) },
  { label: "title type", mutate: (session) => ({ ...session, title: 1 }) },
  { label: "title mismatch", mutate: (session) => ({ ...session, title: "other" }) },
  { label: "agent type", mutate: (session) => ({ ...session, agent: 1 }) },
  { label: "model type", mutate: (session) => ({ ...session, model: [] }) },
  { label: "model missing id", mutate: (session) => ({
    ...session, model: { providerID: session.model.providerID, variant: session.model.variant },
  }) },
  { label: "model id type", mutate: (session) => ({ ...session, model: { ...session.model, id: 1 } }) },
  { label: "model missing provider", mutate: (session) => ({
    ...session, model: { id: session.model.id, variant: session.model.variant },
  }) },
  { label: "model provider type", mutate: (session) => ({ ...session, model: { ...session.model, providerID: 1 } }) },
  { label: "model variant type", mutate: (session) => ({ ...session, model: { ...session.model, variant: 1 } }) },
  { label: "model unknown", mutate: (session) => ({ ...session, model: { ...session.model, unexpected: true } }) },
  { label: "missing version", mutate: (session) => ({ ...session, version: undefined }) },
  { label: "version type", mutate: (session) => ({ ...session, version: 1 }) },
  { label: "version empty", mutate: (session) => ({ ...session, version: "" }) },
  { label: "metadata type", mutate: (session) => ({ ...session, metadata: [] }) },
  { label: "time type", mutate: (session) => ({ ...session, time: [] }) },
  { label: "time missing created", mutate: (session) => ({
    ...session, time: { updated: 11, compacting: 0, archived: -1 },
  }) },
  { label: "time created type", mutate: (session) => ({ ...session, time: { ...session.time, created: "10" } }) },
  { label: "time created nonfinite", mutate: (session) => ({ ...session, time: { ...session.time, created: Number.NaN } }) },
  { label: "time created negative", mutate: (session) => ({ ...session, time: { ...session.time, created: -1 } }) },
  { label: "time created fractional", mutate: (session) => ({ ...session, time: { ...session.time, created: 0.5 } }) },
  { label: "time missing updated", mutate: (session) => ({ ...session, time: { ...session.time, updated: undefined } }) },
  { label: "time updated type", mutate: (session) => ({ ...session, time: { ...session.time, updated: "11" } }) },
  { label: "time updated nonfinite", mutate: (session) => ({ ...session, time: { ...session.time, updated: Number.NaN } }) },
  { label: "time updated negative", mutate: (session) => ({ ...session, time: { ...session.time, updated: -1 } }) },
  { label: "time updated fractional", mutate: (session) => ({ ...session, time: { ...session.time, updated: 10.5 } }) },
  { label: "time updated before created", mutate: (session) => ({ ...session, time: { ...session.time, created: 12, updated: 11 } }) },
  { label: "time compacting type", mutate: (session) => ({ ...session, time: { ...session.time, compacting: "0" } }) },
  { label: "time compacting nonfinite", mutate: (session) => ({ ...session, time: { ...session.time, compacting: Number.NaN } }) },
  { label: "time compacting negative", mutate: (session) => ({ ...session, time: { ...session.time, compacting: -1 } }) },
  { label: "time compacting fractional", mutate: (session) => ({ ...session, time: { ...session.time, compacting: 0.5 } }) },
  { label: "time archived type", mutate: (session) => ({ ...session, time: { ...session.time, archived: "-1" } }) },
  { label: "time archived nonfinite", mutate: (session) => ({ ...session, time: { ...session.time, archived: Number.NaN } }) },
  { label: "time unknown", mutate: (session) => ({ ...session, time: { ...session.time, unexpected: true } }) },
];

export const MALFORMED_SOURCE_SESSION_CASES = [
  ...MALFORMED_SESSION_FIELD_CASES,
  ...MALFORMED_OWNERSHIP_SESSION_CASES,
];

export const nonCleanableSourceSessionCases = () => {
  const session = validSourceCreatedSession();
  const { id: _id, ...missingID } = session;
  return [
    ["empty ID", { ...session, id: "" }],
    ["numeric ID", { ...session, id: 1 }],
    ["missing ID", missingID],
    ["non-object response", null],
  ] as const;
};
