import { basename } from "node:path";
import type { Node } from "web-tree-sitter";
import { commandInvocation, effectiveInvocation } from "./command-invocation";
import {
  assignCwdScope,
  commandCwdFlow,
  conditionalCwdFlow,
  conditionalInputScope,
  isolatedCwdFlow,
  negatedCwdFlow,
  successfulCwdFlow,
  unknownCwdFlow,
  unreachableCwdScope,
  type ShellCwdFlow,
} from "./shell-cwd-flow";
import {
  collectStaticFileReferences,
  collectStaticInputRedirect,
  enterStaticReferenceScope,
  forkStaticReferenceScope,
  shellWord,
  type StaticReferenceCollector,
  type StaticReferenceScope,
} from "./static-file-references";
import {
  enclosingRedirections,
  hasDynamicDescendant,
  shellScriptIndex,
  sourceSlice,
  staticCommandNodes,
  staticFileRedirect,
  structuralShellIssue,
} from "./shell-static";
import type { ShellConnector, ShellIssue, ShellIssueKind, ShellRedirection, ShellSegment } from "./types";

const MAX_AST_DEPTH = 64;
export const MAX_SHELL_SEGMENTS = 256;

export type MutableShellAnalysis = {
  readonly segments: ShellSegment[];
  readonly redirections: ShellRedirection[];
  readonly referenceCollector: StaticReferenceCollector;
  readonly nestedShells: string[];
  readonly issues: Map<string, ShellIssue>;
  readonly byteOffsets: Uint32Array;
  segmentLimitReached: boolean;
};

export type ShellAnalysisBudget = { remainingSegments: number };

type Traversal = {
  readonly source: string;
  readonly state: MutableShellAnalysis;
  readonly budget: ShellAnalysisBudget;
};

type WalkFacts = {
  readonly depth: number;
  readonly nested: boolean;
  readonly stdinFromPipe: boolean;
  readonly connector: ShellConnector;
  readonly subshellDepth: number;
  readonly scope: StaticReferenceScope;
};

export const addShellIssue = (state: MutableShellAnalysis, value: ShellIssue): void => {
  state.issues.set(`${value.kind}:${value.redirectionDirection ?? "-"}:${value.reason}`, value);
};

export const recordShellIssue = (state: MutableShellAnalysis, kind: ShellIssueKind, reason: string): void =>
  addShellIssue(state, { kind, reason });

const shellNames = new Set(["ash", "bash", "dash", "ksh", "mksh", "sh", "zsh"]);

const collectCommand = (node: Node, { source, state, budget }: Traversal, facts: WalkFacts): ShellCwdFlow => {
  const { name: nameNode, arguments: argumentNodes, assignments } = staticCommandNodes(node, source);
  if (!nameNode || hasDynamicDescendant(nameNode)) {
    recordShellIssue(state, "dynamic", "command name is dynamically constructed");
    return unknownCwdFlow(facts.scope);
  }
  const originalExecutable = shellWord(source, nameNode);
  const commandName = originalExecutable.value;
  const argumentWords = argumentNodes.map((argument) => shellWord(source, argument));
  if ([".", "eval", "source"].includes(basename(commandName))) {
    recordShellIssue(state, "unsupported", `shell dispatcher '${basename(commandName)}' requires review`);
  }
  if (budget.remainingSegments <= 0) {
    recordShellIssue(state, "limit", `shell command exceeds ${String(MAX_SHELL_SEGMENTS)} executable segments`);
    state.segmentLimitReached = true;
    return unknownCwdFlow(facts.scope);
  }
  budget.remainingSegments -= 1;
  const redirections = enclosingRedirections(node, source);
  const invocation = effectiveInvocation(commandInvocation({
    executable: originalExecutable,
    arguments: argumentWords,
    assignments,
    cwd: facts.scope.cwd,
    cwdKnown: facts.scope.cwdKnown,
  }));
  const topLevelSegment = state.segments.length;
  state.segments.push({
    source: sourceSlice(source, node),
    normalizedSource: [invocation.commandName, ...invocation.rawArguments].join(" "),
    commandName,
    originalExecutable,
    effectiveExecutable: invocation.effectiveExecutable,
    targetKind: invocation.targetKind,
    executionCwd: invocation.executionCwd,
    executionCwdKnown: invocation.executionCwdKnown,
    arguments: argumentWords.map((word) => word.value),
    rawArguments: argumentNodes.map((argument) => sourceSlice(source, argument)),
    argumentWords,
    environment: assignments,
    assignments: invocation.assignments,
    wrapperChain: invocation.wrapperChain,
    terminalAllowEligible: invocation.terminalAllowEligible,
    redirections,
    startByte: state.byteOffsets[node.startIndex] ?? 0,
    endByte: state.byteOffsets[node.endIndex] ?? state.byteOffsets.at(-1) ?? 0,
    connector: facts.connector,
    topLevel: facts.subshellDepth === 0 && !facts.nested,
    subshellDepth: facts.subshellDepth,
    nested: facts.nested,
    stdinFromPipe: facts.stdinFromPipe,
  });

  collectStaticFileReferences(state.referenceCollector, {
    node,
    source,
    invocation,
    scope: facts.scope,
    topLevelSegment,
    nested: facts.nested,
  });
  const cwdFlow = commandCwdFlow(facts.scope, invocation, redirections.length === 0);

  for (const reason of invocation.reviewReasons) recordShellIssue(state, "identity", reason);
  const shellName = basename(invocation.commandName);
  if (!shellName || !shellNames.has(shellName)) return cwdFlow;
  const shellNodes = argumentNodes.slice(invocation.argumentOffset);
  const scriptIndex = shellScriptIndex(invocation.arguments);
  if (scriptIndex !== undefined && shellNodes[scriptIndex]) {
    if (shellNodes[scriptIndex].type === "raw_string") {
      const quoted = sourceSlice(source, shellNodes[scriptIndex]);
      state.nestedShells.push(quoted.slice(1, -1));
      return cwdFlow;
    }
    recordShellIssue(state, "dynamic", "nested shell -c script is not a static single-quoted literal");
  }
  return cwdFlow;
};

const walk = (node: Node, traversal: Traversal, facts: WalkFacts): ShellCwdFlow | undefined => {
  const { source, state } = traversal;
  if (state.segmentLimitReached) return undefined;
  if (facts.depth > MAX_AST_DEPTH) {
    recordShellIssue(state, "limit", `shell syntax exceeds depth limit ${String(MAX_AST_DEPTH)}`);
    return undefined;
  }
  const nodeIssue = structuralShellIssue(node, source);
  if (nodeIssue) addShellIssue(state, nodeIssue);
  const scope = enterStaticReferenceScope(facts.scope, node.type);
  if (node.type === "file_redirect") {
    const redirection = staticFileRedirect(node, source);
    if (redirection) state.redirections.push(redirection);
    if (!facts.nested) {
      collectStaticInputRedirect(state.referenceCollector, node, source, scope, Math.max(0, state.segments.length - 1));
    }
  }
  const ownFlow = node.type === "command" ? collectCommand(node, traversal, { ...facts, scope }) : undefined;
  const operator = node.type === "list" ? node.children.find((child) => !child.isNamed && ["&&", "||"].includes(child.type)) : undefined;
  if (operator) {
    const index = node.children.indexOf(operator);
    const left = node.children.slice(0, index).find((child) => child.isNamed);
    const right = node.children.slice(index + 1).find((child) => child.isNamed);
    const leftFlow = left ? walk(left, traversal, { ...facts, depth: facts.depth + 1, scope }) : unknownCwdFlow(scope);
    const connector = operator.type === "&&" ? "and" : "or";
    const input = conditionalInputScope(connector, leftFlow ?? unknownCwdFlow(scope));
    const rightFlow = right ? walk(right, traversal, {
      ...facts, depth: facts.depth + 1, connector, scope: input ?? unreachableCwdScope(scope),
    }) : undefined;
    const result = conditionalCwdFlow(connector, leftFlow ?? unknownCwdFlow(scope), input ? rightFlow : undefined);
    assignCwdScope(scope, result.linear);
    return result;
  }
  let pipelineSink = false;
  let connector = facts.connector;
  let result = ownFlow;
  for (const child of node.children) {
    if (state.segmentLimitReached) break;
    if (!child.isNamed && child.type === ";") connector = "sequence";
    if (!child.isNamed && child.type === "&&") connector = "and";
    if (!child.isNamed && child.type === "||") connector = "or";
    if (node.type === "pipeline" && !child.isNamed && ["|", "|&"].includes(child.type)) {
      pipelineSink = true;
      connector = "pipe";
    }
    const childFlow = walk(child, traversal, {
      depth: facts.depth + 1,
      nested: facts.nested,
      stdinFromPipe: facts.stdinFromPipe || pipelineSink,
      connector,
      subshellDepth: facts.subshellDepth + (scope === facts.scope ? 0 : 1),
      scope: node.type === "pipeline" && child.isNamed ? forkStaticReferenceScope(scope) : scope,
    });
    if (child.isNamed && childFlow) result = childFlow;
  }
  if (node.type === "command" && ownFlow) assignCwdScope(scope, ownFlow.linear);
  if (node.type === "command") return ownFlow;
  if (node.type === "pipeline") return unknownCwdFlow(facts.scope);
  if (scope !== facts.scope) {
    return node.type === "function_definition" ? successfulCwdFlow(facts.scope) : isolatedCwdFlow(facts.scope, result);
  }
  return node.type === "negated_command" && result ? negatedCwdFlow(result) : result;
};

export const traverseShellTree = (
  root: Node,
  source: string,
  state: MutableShellAnalysis,
  budget: ShellAnalysisBudget,
  nested: boolean,
): void => {
  if (root.hasError) recordShellIssue(state, "syntax", "shell syntax tree contains an error");
  walk(root, { source, state, budget }, {
    depth: 0,
    nested,
    stdinFromPipe: false,
    connector: "start",
    subshellDepth: 0,
    scope: state.referenceCollector.scope,
  });
};
