import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { xcrunToolLaunchesHostProcess } from "./developer-tool-guards";
import { canonicalPath } from "./path-boundary";
import {
  commandBasename,
  effectiveInvocation,
  xcrunDispatchedInvocation,
  type CommandInvocation,
} from "./command-invocation";
import type { ShellAssignment } from "./types";

const cache = new Map<string, string | undefined>();
const appleSdkName = /^(?:appletvos|appletvsimulator|iphoneos|iphonesimulator|macosx|watchos|watchsimulator|xros|xrsimulator)(?:\d+(?:\.\d+)*)?$/iu;
const defaultToolchains = new Set(["XcodeDefault", "com.apple.dt.toolchain.XcodeDefault"]);

const trustedDeveloperTool = (path: string): boolean => {
  const target = canonicalPath(path);
  return /^\/Applications\/Xcode[^/]*\.app\/Contents\/Developer\//u.test(target) ||
    /^\/Library\/Developer\/CommandLineTools\//u.test(target);
};

type XcrunSelection = {
  readonly lookupArguments: readonly string[];
  readonly trusted: boolean;
};

type XcrunSelector = "sdk" | "toolchain";

const selectorKind = (value: string | undefined): XcrunSelector | undefined => {
  return value === "sdk" || value === "toolchain" ? value : undefined;
};

const selectorTrusted = (kind: XcrunSelector, value: string): boolean => {
  if (kind === "sdk") return appleSdkName.test(value) || (value.startsWith("/") && trustedDeveloperTool(value));
  return defaultToolchains.has(value) || (value.startsWith("/") && trustedDeveloperTool(value));
};

const xcrunSelection = (args: readonly string[]): XcrunSelection => {
  const lookupArguments: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    const separate = selectorKind(argument.match(/^-{1,2}(sdk|toolchain)$/u)?.[1]);
    const attached = argument.match(/^--(sdk|toolchain)=(.*)$/u);
    const kind = separate ?? selectorKind(attached?.[1]);
    if (kind) {
      const value = separate ? args[index += 1] : attached?.[2];
      if (!value || !selectorTrusted(kind, value)) return { lookupArguments, trusted: false };
      lookupArguments.push(`--${kind}`, value);
      continue;
    }
    if (argument === "--" || argument.startsWith("-")) continue;
    break;
  }
  return { lookupArguments, trusted: true };
};

const findDeveloperTool = (
  tool: string,
  lookupArguments: readonly string[],
  environment: readonly ShellAssignment[],
): string | undefined => {
  if (tool.includes("/")) return trustedDeveloperTool(tool) ? canonicalPath(tool) : undefined;
  const developerDirectory = environment.find((entry) => entry.name === "DEVELOPER_DIR")?.value;
  const env = developerDirectory ? { ...process.env, DEVELOPER_DIR: developerDirectory } : process.env;
  const key = [tool, ...lookupArguments, env["DEVELOPER_DIR"] ?? "", env["SDKROOT"] ?? "", env["TOOLCHAINS"] ?? ""].join("\0");
  if (cache.has(key)) return cache.get(key);
  let result: string | undefined;
  try {
    const output = execFileSync("/usr/bin/xcrun", [...lookupArguments, "--find", tool], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    if (output && trustedDeveloperTool(output)) result = canonicalPath(output);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
  cache.set(key, result);
  return result;
};

export type ResolvedXcrunTool = {
  readonly invocation: CommandInvocation;
  readonly requestedName: string;
  readonly canonicalName: string;
  readonly path: string;
};

const normalizeInvocation = (
  target: CommandInvocation,
  requestedName: string,
  canonicalName: string,
): CommandInvocation => {
  const swiftMode = requestedName.match(/^swift-(build|package|repl|run|sdk|test)$/u)?.[1];
  if (swiftMode) return {
    ...target,
    commandName: "swift",
    arguments: [swiftMode, ...target.arguments],
    rawArguments: [swiftMode, ...target.rawArguments],
  };
  if (canonicalName === "clang") return { ...target, commandName: "clang" };
  if (["cpp", "gcc"].includes(canonicalName)) return { ...target, commandName: canonicalName };
  return { ...target, commandName: requestedName };
};

export const resolveXcrunTool = (
  invocation: CommandInvocation,
  environment: readonly ShellAssignment[] = [],
): ResolvedXcrunTool | undefined => {
  if (commandBasename(invocation) !== "xcrun") return undefined;
  const dispatched = xcrunDispatchedInvocation(invocation);
  if (!dispatched) return undefined;
  const selection = xcrunSelection(invocation.arguments);
  if (!selection.trusted) return undefined;
  const target = effectiveInvocation(dispatched);
  const path = findDeveloperTool(target.commandName, selection.lookupArguments, environment);
  if (!path) return undefined;
  const requestedName = commandBasename(target);
  const canonicalName = basename(path);
  return { invocation: normalizeInvocation(target, requestedName, canonicalName), requestedName, canonicalName, path };
};

export const xcrunDispatchNeedsReview = (
  invocation: CommandInvocation,
  environment: readonly ShellAssignment[] = [],
): boolean => {
  if (commandBasename(invocation) !== "xcrun") return false;
  if (!xcrunDispatchedInvocation(invocation)) return false;
  const resolved = resolveXcrunTool(invocation, environment);
  if (!resolved) return true;
  return xcrunToolLaunchesHostProcess(resolved.requestedName, resolved.canonicalName, resolved.invocation.arguments);
};
