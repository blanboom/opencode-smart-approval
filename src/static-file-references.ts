import { basename, isAbsolute } from "node:path";
import type { Node } from "web-tree-sitter";
import type { CommandInvocation } from "./command-invocation";
import { sourceSlice, staticWord } from "./shell-static";
import type { ShellWord, StaticFileReference } from "./types";

const directScriptShells = new Set(["bash", "sh", "zsh"]);
const dynamicWordTypes = new Set([
  "expansion", "simple_expansion", "command_substitution", "process_substitution", "arithmetic_expansion",
]);

export type StaticReferenceCollector = {
  readonly scope: StaticReferenceScope;
  readonly references: StaticFileReference[];
  readonly claimedInputRedirects: Set<string>;
};

export type StaticReferenceScope = {
  cwd: string;
  cwdKnown: boolean;
  relativeReferences: boolean;
  readonly conservativeTopLevel: boolean;
  readonly emitReferences: boolean;
};

type StaticReferenceCommand = {
  readonly node: Node;
  readonly source: string;
  readonly invocation: CommandInvocation;
  readonly scope: StaticReferenceScope;
  readonly topLevelSegment: number;
  readonly nested: boolean;
};

type StaticReferenceCandidate = {
  readonly word: ShellWord;
  readonly kind: StaticFileReference["kind"];
  readonly topLevelSegment: number;
  readonly cwd?: string;
};

type InputReference = { readonly word: ShellWord; readonly identity: string };

const containsUnquotedPattern = (raw: string): boolean => {
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (
      (index === 0 && character === "~")
      || character === "*"
      || character === "?"
      || character === "["
      || character === "{"
      || character === "}"
    ) return true;
  }
  return false;
};

const expansionFree = (node: Node, source: string): boolean => {
  if (dynamicWordTypes.has(node.type)) return false;
  if (["number", "raw_string", "string_content"].includes(node.type)) return true;
  if (node.type === "word") return !containsUnquotedPattern(sourceSlice(source, node));
  if (!["command_name", "concatenation", "string"].includes(node.type)) return false;
  return node.namedChildren.every((child) => expansionFree(child, source));
};

export const shellWord = (source: string, node: Node): ShellWord => ({
  raw: sourceSlice(source, node),
  value: staticWord(source, node),
  expansionFree: expansionFree(node, source),
});

const addReference = (
  collector: StaticReferenceCollector,
  scope: StaticReferenceScope,
  candidate: StaticReferenceCandidate,
): boolean => {
  const { word, kind, topLevelSegment } = candidate;
  if (!scope.emitReferences || !word.expansionFree || word.value.length === 0) return false;
  if (!scope.relativeReferences && !isAbsolute(word.value)) return false;
  const cwd = candidate.cwd ?? scope.cwd;
  collector.references.push({
    kind,
    raw: word.raw,
    value: word.value,
    topLevelSegment,
    cwd,
  });
  return true;
};

const adjacentDescriptor = (redirect: Node): Node | undefined => {
  const previous = redirect.parent?.namedChildren
    .filter((child) => child !== redirect && child.endIndex <= redirect.startIndex)
    .at(-1);
  if (!previous || previous.endIndex !== redirect.startIndex) return undefined;
  if (previous.type === "number") return previous;
  const last = previous.namedChildren.at(-1);
  return last?.type === "number" && last.endIndex === redirect.startIndex ? last : undefined;
};

const inputReference = (redirect: Node, source: string): InputReference | undefined => {
  const operator = redirect.children.find((child) => !child.isNamed)?.type;
  const target = redirect.childForFieldName("destination");
  if (operator !== "<" || !target) return undefined;
  const descriptor = redirect.namedChildren.find((child) => child.type === "file_descriptor")
    ?? adjacentDescriptor(redirect);
  if (descriptor && sourceSlice(source, descriptor) !== "0") return undefined;
  return { word: shellWord(source, target), identity: `${String(redirect.startIndex)}:${String(redirect.endIndex)}` };
};

const sameNode = (left: Node, right: Node): boolean =>
  left.type === right.type && left.startIndex === right.startIndex && left.endIndex === right.endIndex;

const containsNode = (container: Node, node: Node): boolean =>
  container.startIndex <= node.startIndex && container.endIndex >= node.endIndex;

const commandOwnsRedirect = (command: Node, redirect: Node): boolean => {
  const parent = redirect.parent;
  if (parent?.type !== "redirected_statement") return true;
  const body = parent.childForFieldName("body");
  if (!body) return true;
  const target = ["list", "pipeline"].includes(body.type) ? body.namedChildren.at(-1) : body;
  if (!target) return false;
  return target.type === "command" ? sameNode(command, target) : containsNode(target, command);
};

const inputReferences = (node: Node, source: string): readonly InputReference[] => {
  const references: InputReference[] = [];
  for (let ancestor: Node | null = node.parent; ancestor; ancestor = ancestor.parent) {
    for (const redirect of ancestor.namedChildren.filter((child) => child.type === "file_redirect")) {
      if (!commandOwnsRedirect(node, redirect)) continue;
      const reference = inputReference(redirect, source);
      if (reference) references.push(reference);
    }
  }
  return references;
};

const directScriptWord = (invocation: CommandInvocation): ShellWord | undefined => {
  if (!directScriptShells.has(basename(invocation.effectiveExecutable.value))) return undefined;
  const first = invocation.argumentWords[0];
  if (!first) return undefined;
  if (first.value === "--") return invocation.argumentWords[1];
  return first.value.startsWith("-") || first.value.startsWith("+") ? undefined : first;
};

const sourceWord = (invocation: CommandInvocation): ShellWord | undefined => {
  if (invocation.wrapperChain.length > 0 && invocation.targetKind !== "builtin") return undefined;
  if (![".", "source"].includes(invocation.effectiveExecutable.value)) return undefined;
  const operand = invocation.argumentWords[0];
  if (!operand || operand.value.startsWith("-") || operand.value.startsWith("+")) return undefined;
  return operand;
};

export const createStaticReferenceCollector = (cwd: string): StaticReferenceCollector => ({
  scope: { cwd, cwdKnown: true, relativeReferences: true, conservativeTopLevel: true, emitReferences: true },
  references: [],
  claimedInputRedirects: new Set(),
});

export const forkStaticReferenceScope = (
  scope: StaticReferenceScope,
  emitReferences = scope.emitReferences,
): StaticReferenceScope => ({
  cwd: scope.cwd,
  cwdKnown: scope.cwdKnown,
  relativeReferences: scope.relativeReferences,
  conservativeTopLevel: false,
  emitReferences,
});

const childShellTypes = new Set(["subshell", "command_substitution", "process_substitution", "function_definition"]);

export const enterStaticReferenceScope = (scope: StaticReferenceScope, nodeType: string): StaticReferenceScope =>
  childShellTypes.has(nodeType)
    ? forkStaticReferenceScope(scope, nodeType === "function_definition" ? false : scope.emitReferences)
    : scope;

export const collectStaticInputRedirect = (
  collector: StaticReferenceCollector,
  redirect: Node,
  source: string,
  scope: StaticReferenceScope,
  topLevelSegment: number,
): void => {
  const reference = inputReference(redirect, source);
  if (!reference || collector.claimedInputRedirects.has(reference.identity)) return;
  if (addReference(collector, scope, { word: reference.word, kind: "input_redirect", topLevelSegment })) {
    collector.claimedInputRedirects.add(reference.identity);
  }
};

export const collectStaticFileReferences = (
  collector: StaticReferenceCollector,
  command: StaticReferenceCommand,
): void => {
  const { invocation, scope, topLevelSegment } = command;
  if (!command.nested) {
    const executables = [
      ...invocation.wrapperChain.map((wrapper) => ({ word: wrapper.executable, cwd: wrapper.executionCwd })),
      ...(invocation.targetKind === "external"
        ? [{ word: invocation.effectiveExecutable, cwd: invocation.executionCwd }]
        : []),
    ];
    for (const executable of executables) {
      if (executable.word.value.includes("/")) {
        addReference(collector, scope, {
          word: executable.word,
          kind: "executable",
          topLevelSegment,
          cwd: executable.cwd,
        });
      }
    }
    const script = directScriptWord(invocation);
    if (script) {
      addReference(collector, scope, {
        word: script,
        kind: "shell_script",
        topLevelSegment,
        cwd: invocation.executionCwd,
      });
    }
    const source = sourceWord(invocation);
    if (source) {
      addReference(collector, scope, {
        word: source,
        kind: "source",
        topLevelSegment,
        cwd: invocation.executionCwd,
      });
    }
    for (const reference of inputReferences(command.node, command.source)) {
      if (collector.claimedInputRedirects.has(reference.identity)) continue;
      if (addReference(collector, scope, { word: reference.word, kind: "input_redirect", topLevelSegment })) {
        collector.claimedInputRedirects.add(reference.identity);
      }
    }
  }
};
