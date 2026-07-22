import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { effectiveInvocation, invocationFromSegment } from "./command-invocation";
import { isProvenObserver, mutationTargets } from "./config-mutation-targets";
import { canonicalPath } from "./path-boundary";
import type { ShellAnalysis } from "./types";

export type ConfigWriteRequest = {
  readonly tool: string;
  readonly args: unknown;
  readonly directory: string;
  readonly policyPaths: readonly string[];
  readonly analysis?: ShellAnalysis;
};

export type ConfigWriteFinding =
  | { readonly action: "block"; readonly path: string; readonly reason: string }
  | { readonly action: "force_review"; readonly reason: string }
  | { readonly action: "none" };

const NONE = { action: "none" } as const;
const shellTools = new Set(["bash", "shell", "shell_command", "exec_command"]);
const fileTools = new Set(["write", "edit"]);
const patchTools = new Set(["apply_patch", "patch"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
};

const resolvedPath = (path: string, directory: string): string => {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(directory, path);
};

const exactPolicyPath = (
  candidate: string,
  directory: string,
  policyPaths: ReadonlySet<string>,
): string | undefined => {
  const resolved = canonicalPath(resolvedPath(candidate, directory));
  return policyPaths.has(resolved) ? resolved : undefined;
};

const mentionsPolicyPath = (
  value: string,
  directory: string,
  directoryKnown: boolean,
  policyPaths: ReadonlySet<string>,
): boolean => {
  if (!directoryKnown && !isAbsolute(value)) {
    return [...policyPaths].some((path) => value.includes(basename(path)));
  }
  if (exactPolicyPath(value, directory, policyPaths)) return true;
  for (const path of policyPaths) {
    if (value.includes(path)) return true;
    const name = basename(path);
    if (value.includes(name) && exactPolicyPath(name, directory, policyPaths)) return true;
  }
  return false;
};

const analyses = (analysis: ShellAnalysis): readonly ShellAnalysis[] => [
  analysis,
  ...analysis.nestedAnalyses.flatMap(analyses),
];

const block = (path: string, reason: string): ConfigWriteFinding => ({ action: "block", path, reason });
const forceReview = (reason: string): ConfigWriteFinding => ({ action: "force_review", reason });

const shellFinding = (
  analysis: ShellAnalysis,
  directory: string,
  policyPaths: ReadonlySet<string>,
): ConfigWriteFinding => {
  let ambiguous = false;
  for (const current of analyses(analysis)) {
    for (const redirection of current.redirections) {
      if (redirection.operator.startsWith("<")) continue;
      if (!isAbsolute(redirection.target.value)) continue;
      const path = exactPolicyPath(redirection.target.value, directory, policyPaths);
      if (path) return block(path, "shell output redirection targets the approval configuration");
    }
    if (current.issues.some((issue) =>
      issue.reason === "file redirection requires review" && issue.redirectionDirection !== "input"
    )) ambiguous = true;
    for (const segment of current.segments) {
      const invocation = effectiveInvocation(invocationFromSegment(segment));
      for (const redirection of segment.redirections) {
        if (redirection.operator.startsWith("<")) continue;
        if (!invocation.executionCwdKnown && !isAbsolute(redirection.target.value)) {
          ambiguous = true;
          continue;
        }
        const path = exactPolicyPath(redirection.target.value, invocation.executionCwd, policyPaths);
        if (path) return block(path, "shell output redirection targets the approval configuration");
      }
      const mutation = mutationTargets(invocation);
      for (const target of mutation.exactTargets) {
        if (!invocation.executionCwdKnown && !isAbsolute(target)) {
          ambiguous = true;
          continue;
        }
        const path = exactPolicyPath(target, invocation.executionCwd, policyPaths);
        if (path) return block(path, "shell command targets the approval configuration");
      }
      if (mutation.ambiguous) ambiguous = true;
      if (!mutation.recognized && !isProvenObserver(invocation) && invocation.arguments.some((argument) =>
        mentionsPolicyPath(argument, invocation.executionCwd, invocation.executionCwdKnown, policyPaths)
      )) {
        ambiguous = true;
      }
    }
  }
  return ambiguous
    ? forceReview("approval configuration mutation cannot be ruled out")
    : NONE;
};

const patchPaths = (patchText: string): readonly string[] => patchText
  .split(/\r?\n/u)
  .flatMap((line) => {
    const match = /^\*\*\* (?:Add|Delete|Update) File: (.+)$/u.exec(line) ?? /^\*\*\* Move to: (.+)$/u.exec(line);
    return match?.[1] ? [match[1]] : [];
  });

export const findConfigWrite = (request: ConfigWriteRequest): ConfigWriteFinding => {
  const tool = request.tool.toLowerCase();
  const policyPaths = new Set(request.policyPaths.map(canonicalPath));
  if (fileTools.has(tool)) {
    const filePath = stringField(request.args, "filePath");
    if (!filePath) return NONE;
    const path = exactPolicyPath(filePath, request.directory, policyPaths);
    return path ? block(path, `${tool} targets the approval configuration`) : NONE;
  }
  if (patchTools.has(tool)) {
    const patchText = stringField(request.args, "patchText");
    if (!patchText) return NONE;
    for (const candidate of patchPaths(patchText)) {
      const path = exactPolicyPath(candidate, request.directory, policyPaths);
      if (path) return block(path, `${tool} targets the approval configuration`);
    }
    return NONE;
  }
  if (!shellTools.has(tool)) return NONE;
  return request.analysis ? shellFinding(request.analysis, request.directory, policyPaths) : forceReview("shell analysis is unavailable");
};
