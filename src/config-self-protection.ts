import { basename, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { canonicalPath } from "./path-boundary";
import { commandBasename, effectiveInvocation, invocationFromSegment, type CommandInvocation } from "./command-invocation";
import { analyzeShell } from "./shell-analysis";
import type { ShellAnalysis } from "./types";

export type ConfigWriteRequest = {
  readonly tool: string;
  readonly args: unknown;
  readonly directory: string;
  readonly policyPaths: readonly string[];
};

export type ConfigWriteFinding = {
  readonly path: string;
  readonly reason: string;
};

const shellTools = new Set(["bash", "shell", "shell_command", "exec_command"]);
const fileTools = new Set(["write", "edit"]);
const patchTools = new Set(["apply_patch", "patch"]);
const allPathWriters = new Set(["chmod", "chown", "ln", "mv", "rm", "touch", "truncate", "unlink"]);
const destinationWriters = new Set(["cp", "install", "rsync"]);
const directoryDestinationWriters = new Set(["cp", "install", "ln", "mv", "rsync"]);
const targetDirectoryWriters = new Set(["cp", "install", "ln", "mv"]);
const rsyncOptionsWithValues = new Set([
  "-B", "-e", "-f", "-M", "-T",
  "--address", "--backup-dir", "--block-size", "--bwlimit", "--checksum-choice", "--checksum-seed",
  "--chmod", "--compare-dest", "--compress-choice", "--compress-level", "--contimeout", "--copy-as",
  "--copy-dest", "--debug", "--exclude", "--exclude-from", "--files-from", "--filter", "--groupmap",
  "--iconv", "--include", "--include-from", "--info", "--link-dest", "--log-file", "--log-file-format",
  "--max-alloc", "--max-delete", "--max-size", "--min-size", "--modify-window", "--out-format",
  "--partial-dir", "--password-file", "--port", "--protocol", "--read-batch", "--remote-option",
  "--rsync-path", "--sockopts", "--suffix", "--temp-dir", "--timeout", "--usermap", "--write-batch",
  "--only-write-batch",
]);
const interpreterWriters = new Set([
  "awk", "bash", "bun", "deno", "gawk", "lua", "mawk", "node", "perl", "php", "python", "python3", "ruby", "sh", "zsh",
]);

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

const protectedPath = (
  candidate: string,
  directory: string,
  protectedPaths: ReadonlySet<string>,
): string | undefined => {
  const resolved = canonicalPath(resolvedPath(candidate, directory));
  return protectedPaths.has(resolved) ? resolved : undefined;
};

const protectedPathFromDirectories = (
  candidate: string,
  directories: ReadonlySet<string>,
  protectedPaths: ReadonlySet<string>,
): string | undefined => {
  for (const directory of directories) {
    const path = protectedPath(candidate, directory, protectedPaths);
    if (path) return path;
  }
  return undefined;
};

const protectedPathMention = (
  value: string,
  directories: ReadonlySet<string>,
  protectedPaths: ReadonlySet<string>,
): string | undefined => {
  for (const path of protectedPaths) {
    if (value.includes(path)) return path;
    const name = basename(path);
    if (!value.includes(name)) continue;
    const relativeMatch = protectedPathFromDirectories(name, directories, protectedPaths);
    if (relativeMatch) return relativeMatch;
  }
  return undefined;
};

const commandName = (invocation: Pick<CommandInvocation, "commandName">): string =>
  commandBasename(invocation).toLowerCase();

const nonOptionArguments = (invocation: CommandInvocation): readonly string[] => {
  const operands: string[] = [];
  let optionsEnded = false;
  for (const argument of invocation.arguments) {
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && argument.startsWith("-")) continue;
    operands.push(argument);
  }
  return operands;
};

type DestinationArguments = {
  readonly destination: string;
  readonly sources: readonly string[];
};

type DestinationParseState = {
  readonly operands: readonly string[];
  readonly optionsEnded: boolean;
  readonly pendingValue: "option" | "target-directory" | undefined;
  readonly targetDirectory: string | undefined;
};

const destinationArgumentVariants = (invocation: CommandInvocation): readonly DestinationArguments[] => {
  const name = commandName(invocation);
  const supportsTargetDirectory = targetDirectoryWriters.has(name);
  let states: readonly DestinationParseState[] = [{
    operands: [],
    optionsEnded: false,
    pendingValue: undefined,
    targetDirectory: undefined,
  }];
  for (const argument of invocation.arguments) {
    const nextStates = states.flatMap((state): readonly DestinationParseState[] => {
      if (state.pendingValue === "target-directory") {
        return [{ ...state, pendingValue: undefined, targetDirectory: argument }];
      }
      if (state.pendingValue === "option") return [{ ...state, pendingValue: undefined }];
      if (!state.optionsEnded && argument === "--") return [{ ...state, optionsEnded: true }];
      if (state.optionsEnded || !argument.startsWith("-")) {
        return [{ ...state, operands: [...state.operands, argument] }];
      }
      if (supportsTargetDirectory && (argument === "-t" || argument === "--target-directory")) {
        return [{ ...state, pendingValue: "target-directory" }];
      }
      const attachedTarget = supportsTargetDirectory
        ? /^(?:-t|--target-directory=)(.+)$/u.exec(argument)?.[1]
        : undefined;
      if (attachedTarget) return [{ ...state, targetDirectory: attachedTarget }];
      if (argument.includes("=") || (name === "rsync" && /^-(?:B|e|f|M|T).+/u.test(argument))) return [state];
      if (name === "rsync" && rsyncOptionsWithValues.has(argument)) {
        return [{ ...state, pendingValue: "option" }];
      }
      return [state, { ...state, pendingValue: "option" }];
    });
    const uniqueStates = new Map<string, DestinationParseState>();
    for (const state of nextStates) {
      uniqueStates.set(
        `${state.optionsEnded ? "1" : "0"}:${state.pendingValue ?? "-"}:${state.targetDirectory ?? "-"}:${state.operands.join("\0")}`,
        state,
      );
    }
    if (uniqueStates.size > 64) {
      const candidates = nonOptionArguments(invocation);
      return candidates.map((destination, index) => ({ destination, sources: candidates.slice(0, index) }));
    }
    states = [...uniqueStates.values()];
  }
  return states.flatMap((state) => {
    if (state.targetDirectory) return [{ destination: state.targetDirectory, sources: state.operands }];
    const destination = state.operands.at(-1);
    return destination ? [{ destination, sources: state.operands.slice(0, -1) }] : [];
  });
};

const writerTargets = (invocation: CommandInvocation): readonly string[] => {
  const name = commandName(invocation);
  const pathArguments = nonOptionArguments(invocation);
  if (directoryDestinationWriters.has(name)) {
    const parsed = destinationArgumentVariants(invocation);
    if (parsed.length === 0) return pathArguments;
    const expandedDestinations = parsed.flatMap((entry) =>
      entry.sources.map((source) => join(entry.destination, basename(source)))
    );
    if (allPathWriters.has(name)) return [...pathArguments, ...expandedDestinations];
    return [...parsed.map((entry) => entry.destination), ...expandedDestinations];
  }
  if (allPathWriters.has(name)) return pathArguments;
  if (destinationWriters.has(name)) return pathArguments.slice(-1);
  if (name === "tee") return nonOptionArguments(invocation);
  if (name === "dd") return invocation.arguments.filter((argument) => argument.startsWith("of=")).map((argument) => argument.slice(3));
  if (name === "sed" && invocation.arguments.some((argument) => argument === "-i" || argument.startsWith("-i") || argument.startsWith("--in-place"))) {
    return nonOptionArguments(invocation);
  }
  if (name === "perl" && invocation.arguments.some((argument) => /^-[^-]*i/u.test(argument))) {
    return nonOptionArguments(invocation);
  }
  if (interpreterWriters.has(name)) {
    return invocation.arguments;
  }
  return [];
};

const possibleWorkingDirectories = (analysis: ShellAnalysis, directory: string): ReadonlySet<string> => {
  const directories = new Set([canonicalPath(directory)]);
  for (const current of analyses(analysis)) {
    for (const segment of current.segments) {
      const invocation = effectiveInvocation(invocationFromSegment(segment));
      const name = commandName(invocation);
      if (name !== "cd" && name !== "pushd") continue;
      const target = nonOptionArguments(invocation)[0] ?? (name === "cd" ? homedir() : undefined);
      if (!target || target === "-") continue;
      for (const base of [...directories]) {
        directories.add(canonicalPath(resolvedPath(target, base)));
      }
    }
  }
  return directories;
};

const analyses = (analysis: ShellAnalysis): readonly ShellAnalysis[] => [
  analysis,
  ...analysis.nestedAnalyses.flatMap(analyses),
];

const shellFinding = async (
  command: string,
  directory: string,
  protectedPaths: ReadonlySet<string>,
): Promise<ConfigWriteFinding | undefined> => {
  const analysis = await analyzeShell(command);
  const directories = possibleWorkingDirectories(analysis, directory);
  for (const current of analyses(analysis)) {
    for (const redirection of current.redirections) {
      if (redirection.operator.startsWith("<")) continue;
      const path = protectedPathFromDirectories(redirection.target.value, directories, protectedPaths);
      if (path) return { path, reason: "shell output redirection targets the approval configuration" };
    }
    for (const segment of current.segments) {
      const invocation = effectiveInvocation(invocationFromSegment(segment));
      for (const target of writerTargets(invocation)) {
        const path = protectedPathFromDirectories(target, directories, protectedPaths);
        if (path) {
          return { path, reason: `${commandName(invocation)} targets the approval configuration` };
        }
      }
      if (interpreterWriters.has(commandName(invocation))) {
        for (const argument of invocation.arguments) {
          const path = protectedPathMention(argument, directories, protectedPaths);
          if (path) return { path, reason: `${commandName(invocation)} code references the approval configuration` };
        }
      }
    }
  }
  const hasDynamicOutput = analyses(analysis).some((current) =>
    current.issues.some((issue) => issue.reason === "file redirection requires review")
  );
  if (hasDynamicOutput) {
    const path = protectedPathMention(command, directories, protectedPaths) ?? protectedPaths.values().next().value;
    if (path) return { path, reason: "dynamic shell output cannot exclude the approval configuration" };
  }
  return undefined;
};

const patchPaths = (patchText: string): readonly string[] => patchText
  .split(/\r?\n/u)
  .flatMap((line) => {
    const match = /^\*\*\* (?:Add|Delete|Update) File: (.+)$/u.exec(line) ?? /^\*\*\* Move to: (.+)$/u.exec(line);
    return match?.[1] ? [match[1]] : [];
  });

export const findConfigWrite = async (request: ConfigWriteRequest): Promise<ConfigWriteFinding | undefined> => {
  const tool = request.tool.toLowerCase();
  const protectedPaths = new Set(request.policyPaths.map(canonicalPath));
  if (fileTools.has(tool)) {
    const filePath = stringField(request.args, "filePath");
    if (!filePath) return undefined;
    const path = protectedPath(filePath, request.directory, protectedPaths);
    return path ? { path, reason: `${tool} targets the approval configuration` } : undefined;
  }
  if (patchTools.has(tool)) {
    const patchText = stringField(request.args, "patchText");
    if (!patchText) return undefined;
    for (const candidate of patchPaths(patchText)) {
      const path = protectedPath(candidate, request.directory, protectedPaths);
      if (path) return { path, reason: `${tool} targets the approval configuration` };
    }
    return undefined;
  }
  if (!shellTools.has(tool)) return undefined;
  const command = stringField(request.args, "command") ?? stringField(request.args, "cmd") ?? stringField(request.args, "code");
  return command ? shellFinding(command, request.directory, protectedPaths) : undefined;
};
