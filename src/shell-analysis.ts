import { basename } from "node:path";
import type { Node } from "web-tree-sitter";
import { effectiveInvocation } from "./command-invocation";
import { withShellTree } from "./shell-parser";
import {
  byteOffsetsFor,
  controlCharacterIssue,
  enclosingRedirections,
  hasDynamicDescendant,
  safeFileRedirect,
  shellScriptIndex,
  sourceSlice,
  staticFileRedirect,
  staticWord,
} from "./shell-static";
import type { ShellAnalysis, ShellIssue, ShellIssueKind, ShellRedirection, ShellSegment } from "./types";

const MAX_SOURCE_BYTES = 128 * 1024;
const MAX_AST_DEPTH = 64;
const MAX_SEGMENTS = 256;
const MAX_NESTED_SHELL_DEPTH = 8;

const safeNamedTypes = new Set([
  "program",
  "list",
  "pipeline",
  "command",
  "command_name",
  "word",
  "number",
  "raw_string",
  "string",
  "string_content",
  "concatenation",
  "comment",
  "subshell",
  "compound_statement",
  "negated_command",
  "variable_assignment",
  "variable_name",
  "redirected_statement",
  "file_redirect",
  "file_descriptor",
]);

type MutableAnalysis = {
  readonly segments: ShellSegment[];
  readonly redirections: ShellRedirection[];
  readonly nestedShells: string[];
  readonly issues: Map<string, ShellIssue>;
  readonly byteOffsets: Uint32Array;
  segmentLimitReached: boolean;
};

type AnalysisBudget = {
  remainingSegments: number;
};

const issue = (state: MutableAnalysis, kind: ShellIssueKind, reason: string): void => {
  state.issues.set(`${kind}:${reason}`, { kind, reason });
};

const shellNames = new Set(["ash", "bash", "dash", "ksh", "mksh", "sh", "zsh"]);

const collectCommand = (
  node: Node,
  source: string,
  state: MutableAnalysis,
  budget: AnalysisBudget,
  nested: boolean,
  stdinFromPipe: boolean,
): void => {
  const nameNode = node.childForFieldName("name");
  if (!nameNode || hasDynamicDescendant(nameNode)) {
    issue(state, "dynamic", "command name is dynamically constructed");
    return;
  }
  const commandName = staticWord(source, nameNode);
  const argumentNodes = node.childrenForFieldName("argument");
  const args = argumentNodes.map((argument) => staticWord(source, argument));
  if ([".", "eval", "exec", "source"].includes(basename(commandName))) {
    issue(state, "unsupported", `shell dispatcher '${basename(commandName)}' requires review`);
  }
  if (budget.remainingSegments <= 0) {
    issue(state, "limit", `shell command exceeds ${String(MAX_SEGMENTS)} executable segments`);
    state.segmentLimitReached = true;
    return;
  }
  budget.remainingSegments -= 1;
  const segmentSource = sourceSlice(source, node);
  const redirections = enclosingRedirections(node, source);
  const assignments = node.namedChildren
    .filter((child) => child.type === "variable_assignment")
    .map((assignment) => {
      const parts = assignment.namedChildren;
      const name = parts[0] ? staticWord(source, parts[0]) : "";
      const value = parts[1] ? staticWord(source, parts[1]) : "";
      return { name, value, raw: sourceSlice(source, assignment) };
    });
  const invocation = effectiveInvocation({
    commandName,
    arguments: args,
    rawArguments: argumentNodes.map((argument) => sourceSlice(source, argument)),
    argumentOffset: 0,
    reviewReasons: [],
  });
  state.segments.push({
    source: segmentSource,
    normalizedSource: [invocation.commandName, ...invocation.rawArguments].join(" "),
    commandName,
    arguments: args,
    rawArguments: argumentNodes.map((argument) => sourceSlice(source, argument)),
    environment: assignments,
    redirections,
    startByte: state.byteOffsets[node.startIndex] ?? 0,
    endByte: state.byteOffsets[node.endIndex] ?? state.byteOffsets.at(-1) ?? 0,
    nested,
    stdinFromPipe,
  });

  for (const reason of invocation.reviewReasons) issue(state, "unsupported", reason);
  const shellName = basename(invocation.commandName);
  if (!shellName || !shellNames.has(shellName)) return;
  const shellArgs = invocation.arguments;
  const shellNodes = argumentNodes.slice(invocation.argumentOffset);
  const scriptIndex = shellScriptIndex(shellArgs);
  if (scriptIndex !== undefined && shellNodes[scriptIndex]) {
    if (shellNodes[scriptIndex].type === "raw_string") {
      const quoted = sourceSlice(source, shellNodes[scriptIndex]);
      state.nestedShells.push(quoted.slice(1, -1));
      return;
    }
    issue(state, "dynamic", "nested shell -c script is not a static single-quoted literal");
  }
};

const walk = (
  node: Node,
  source: string,
  state: MutableAnalysis,
  budget: AnalysisBudget,
  depth: number,
  nested: boolean,
  stdinFromPipe: boolean,
): void => {
  if (state.segmentLimitReached) return;
  if (depth > MAX_AST_DEPTH) {
    issue(state, "limit", `shell syntax exceeds depth limit ${String(MAX_AST_DEPTH)}`);
    return;
  }
  if (node.isError || node.isMissing) issue(state, "syntax", "shell syntax contains an error or missing token");
  if (node.isNamed && !safeNamedTypes.has(node.type)) {
    const kind: ShellIssueKind = [
      "expansion",
      "simple_expansion",
      "command_substitution",
      "process_substitution",
      "arithmetic_expansion",
    ].includes(node.type)
      ? "dynamic"
      : "unsupported";
    issue(state, kind, `shell syntax '${node.type}' requires review`);
  }
  if (!node.isNamed && node.type === "&") {
    issue(state, "unsupported", "background execution requires review");
  }
  if (node.type === "file_redirect" && !safeFileRedirect(node, source)) {
    issue(state, "unsupported", "file redirection requires review");
  }
  if (node.type === "file_redirect") {
    const redirection = staticFileRedirect(node, source);
    if (redirection) state.redirections.push(redirection);
  }
  if (node.type === "variable_assignment" && node.parent?.type !== "command") {
    issue(state, "unsupported", "standalone variable assignment changes later shell state");
  }
  if (node.type === "command") collectCommand(node, source, state, budget, nested, stdinFromPipe);
  let pipelineSink = false;
  for (const child of node.children) {
    if (state.segmentLimitReached) break;
    if (node.type === "pipeline" && !child.isNamed && ["|", "|&"].includes(child.type)) {
      pipelineSink = true;
    }
    walk(child, source, state, budget, depth + 1, nested, stdinFromPipe || pipelineSink);
  }
};

const analyze = async (source: string, nestedDepth: number, budget: AnalysisBudget): Promise<ShellAnalysis> => {
  const bytes = Buffer.from(source, "utf8");
  if (bytes.byteLength > MAX_SOURCE_BYTES) {
    return {
      source,
      segments: [],
      redirections: [],
      issues: [{ kind: "limit", reason: "shell command exceeds 128 KiB" }],
      nestedAnalyses: [],
    };
  }
  const controlIssue = controlCharacterIssue(source);
  if (controlIssue) return { source, segments: [], redirections: [], issues: [controlIssue], nestedAnalyses: [] };
  const state: MutableAnalysis = {
    segments: [],
    redirections: [],
    nestedShells: [],
    issues: new Map(),
    byteOffsets: byteOffsetsFor(source),
    segmentLimitReached: false,
  };
  const nestedAnalyses: ShellAnalysis[] = [];
  await withShellTree(source, (root) => {
    if (root.hasError) issue(state, "syntax", "shell syntax tree contains an error");
    walk(root, source, state, budget, 0, false, false);
  });
  if (nestedDepth >= MAX_NESTED_SHELL_DEPTH && state.nestedShells.length > 0) {
    issue(state, "limit", "nested shell depth limit exceeded");
  } else {
    for (const nestedSource of state.nestedShells) {
      if (budget.remainingSegments <= 0) {
        issue(state, "limit", `shell command exceeds ${String(MAX_SEGMENTS)} executable segments`);
        break;
      }
      const nestedAnalysis = await analyze(nestedSource, nestedDepth + 1, budget);
      nestedAnalyses.push(nestedAnalysis);
      state.segments.push(...nestedAnalysis.segments.map((segment) => ({ ...segment, nested: true })));
      for (const nestedIssue of nestedAnalysis.issues) {
        issue(state, nestedIssue.kind, `nested shell: ${nestedIssue.reason}`);
      }
    }
  }
  if (state.segments.length > MAX_SEGMENTS) {
    issue(state, "limit", `shell command exceeds ${String(MAX_SEGMENTS)} executable segments`);
  }
  return {
    source,
    segments: state.segments.slice(0, MAX_SEGMENTS),
    redirections: state.redirections,
    issues: [...state.issues.values()],
    nestedAnalyses,
  };
};

export const analyzeShell = async (source: string): Promise<ShellAnalysis> =>
  analyze(source, 0, { remainingSegments: MAX_SEGMENTS });
