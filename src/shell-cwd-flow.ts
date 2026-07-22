import { isAbsolute, resolve } from "node:path";
import type { CommandInvocation } from "./command-invocation";
import type { StaticReferenceScope } from "./static-file-references";
import type { ShellConnector, ShellWord } from "./types";

export type ShellCwdFlow = {
  readonly success?: StaticReferenceScope;
  readonly failure?: StaticReferenceScope;
  readonly linear: StaticReferenceScope;
};

const cloneScope = (
  scope: StaticReferenceScope,
  emitReferences = scope.emitReferences,
): StaticReferenceScope => ({ ...scope, emitReferences });

const flow = (
  success: StaticReferenceScope | undefined,
  failure: StaticReferenceScope | undefined,
  linear: StaticReferenceScope,
): ShellCwdFlow => ({
  ...(success ? { success } : {}),
  ...(failure ? { failure } : {}),
  linear,
});

const mergeScopes = (...candidates: readonly (StaticReferenceScope | undefined)[]): StaticReferenceScope | undefined => {
  const scopes = candidates.filter((candidate): candidate is StaticReferenceScope => candidate !== undefined);
  const first = scopes[0];
  if (!first) return undefined;
  const cwdKnown = first.cwdKnown && scopes.every((scope) => scope.cwdKnown && scope.cwd === first.cwd);
  return {
    cwd: first.cwd,
    cwdKnown,
    relativeReferences: cwdKnown && scopes.every((scope) => scope.relativeReferences),
    conservativeTopLevel: first.conservativeTopLevel,
    emitReferences: scopes.every((scope) => scope.emitReferences),
  };
};

export const assignCwdScope = (target: StaticReferenceScope, source: StaticReferenceScope): void => {
  target.cwd = source.cwd;
  target.cwdKnown = source.cwdKnown;
  target.relativeReferences = source.relativeReferences;
};

export const unknownCwdFlow = (scope: StaticReferenceScope): ShellCwdFlow =>
  flow(cloneScope(scope), cloneScope(scope), cloneScope(scope));

export const successfulCwdFlow = (scope: StaticReferenceScope): ShellCwdFlow =>
  flow(cloneScope(scope), undefined, cloneScope(scope));

export const isolatedCwdFlow = (parent: StaticReferenceScope, child: ShellCwdFlow | undefined): ShellCwdFlow => {
  if (!child) return unknownCwdFlow(parent);
  return flow(
    child.success ? cloneScope(parent) : undefined,
    child.failure ? cloneScope(parent) : undefined,
    cloneScope(parent),
  );
};

export const negatedCwdFlow = (result: ShellCwdFlow): ShellCwdFlow =>
  flow(result.failure, result.success, cloneScope(result.linear));

export const unreachableCwdScope = (scope: StaticReferenceScope): StaticReferenceScope =>
  cloneScope(scope, false);

export const conditionalInputScope = (
  connector: Extract<ShellConnector, "and" | "or">,
  left: ShellCwdFlow,
): StaticReferenceScope | undefined => connector === "and" ? left.success : left.failure;

export const conditionalCwdFlow = (
  connector: Extract<ShellConnector, "and" | "or">,
  left: ShellCwdFlow,
  right: ShellCwdFlow | undefined,
): ShellCwdFlow => {
  const success = connector === "and" ? right?.success : mergeScopes(left.success, right?.success);
  const failure = connector === "and" ? mergeScopes(left.failure, right?.failure) : right?.failure;
  return flow(success, failure, mergeScopes(success, failure) ?? cloneScope(left.linear));
};

const cdDirectory = (invocation: CommandInvocation): ShellWord | undefined => {
  let operand: ShellWord | undefined;
  let options = true;
  for (const word of invocation.argumentWords) {
    if (options && ["-L", "-P"].includes(word.value)) continue;
    if (options && word.value === "--") {
      options = false;
      continue;
    }
    if (options && word.value.startsWith("-") && word.value !== "-") return undefined;
    if (operand) return undefined;
    operand = word;
    options = false;
  }
  return operand;
};

const successfulCdScope = (scope: StaticReferenceScope, invocation: CommandInvocation): StaticReferenceScope => {
  const changed = cloneScope(scope);
  const directory = cdDirectory(invocation);
  if (!directory?.expansionFree || !directory.value || directory.value === "-") {
    changed.cwdKnown = false;
    changed.relativeReferences = false;
    return changed;
  }
  if (!changed.cwdKnown && !isAbsolute(directory.value)) {
    changed.relativeReferences = false;
    return changed;
  }
  changed.cwd = resolve(changed.cwd, directory.value);
  changed.cwdKnown = true;
  changed.relativeReferences = !changed.conservativeTopLevel;
  return changed;
};

export const commandCwdFlow = (
  scope: StaticReferenceScope,
  invocation: CommandInvocation,
  intrinsicSuccess = true,
): ShellCwdFlow => {
  const directName = invocation.wrapperChain.length === 0 ? invocation.effectiveExecutable.value : undefined;
  if (directName === "true" && intrinsicSuccess) return successfulCwdFlow(scope);
  if (directName === "false") return flow(undefined, cloneScope(scope), cloneScope(scope));
  if (invocation.targetKind !== "builtin" || invocation.effectiveExecutable.value !== "cd") {
    return unknownCwdFlow(scope);
  }
  const success = successfulCdScope(scope, invocation);
  const failure = cloneScope(scope);
  return flow(success, failure, mergeScopes(success, failure) ?? cloneScope(scope));
};
