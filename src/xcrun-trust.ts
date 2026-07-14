import { execFileSync } from "node:child_process";
import { constants, accessSync } from "node:fs";
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

type DeveloperToolLookup =
  | { readonly status: "trusted"; readonly path: string }
  | { readonly status: "untrusted" }
  | { readonly status: "unavailable" };

const cache = new Map<string, DeveloperToolLookup>();
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
): DeveloperToolLookup => {
  if (tool.includes("/")) {
    try {
      accessSync(tool, constants.X_OK);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { status: "unavailable" };
    }
    return trustedDeveloperTool(tool)
      ? { status: "trusted", path: canonicalPath(tool) }
      : { status: "untrusted" };
  }
  const developerDirectory = environment.find((entry) => entry.name === "DEVELOPER_DIR")?.value;
  const env = developerDirectory ? { ...process.env, DEVELOPER_DIR: developerDirectory } : process.env;
  const key = [tool, ...lookupArguments, env["DEVELOPER_DIR"] ?? "", env["SDKROOT"] ?? "", env["TOOLCHAINS"] ?? ""].join("\0");
  const cached = cache.get(key);
  if (cached) return cached;
  let result: DeveloperToolLookup = { status: "unavailable" };
  try {
    const output = execFileSync("/usr/bin/xcrun", [...lookupArguments, "--find", tool], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    if (output) {
      result = trustedDeveloperTool(output)
        ? { status: "trusted", path: canonicalPath(output) }
        : { status: "untrusted" };
    }
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

type XcrunToolResolution =
  | { readonly status: "resolved"; readonly tool: ResolvedXcrunTool }
  | { readonly status: "untrusted" }
  | { readonly status: "unavailable" };

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

const xcrunToolResolution = (
  invocation: CommandInvocation,
  environment: readonly ShellAssignment[] = [],
): XcrunToolResolution | undefined => {
  if (commandBasename(invocation) !== "xcrun") return undefined;
  const dispatched = xcrunDispatchedInvocation(invocation);
  if (!dispatched) return undefined;
  const selection = xcrunSelection(invocation.arguments);
  if (!selection.trusted) return undefined;
  const target = effectiveInvocation(dispatched);
  const lookup = findDeveloperTool(target.commandName, selection.lookupArguments, environment);
  if (lookup.status !== "trusted") return lookup;
  const requestedName = commandBasename(target);
  const canonicalName = basename(lookup.path);
  return {
    status: "resolved",
    tool: {
      invocation: normalizeInvocation(target, requestedName, canonicalName),
      requestedName,
      canonicalName,
      path: lookup.path,
    },
  };
};

export const resolveXcrunTool = (
  invocation: CommandInvocation,
  environment: readonly ShellAssignment[] = [],
): ResolvedXcrunTool | undefined => {
  const resolution = xcrunToolResolution(invocation, environment);
  return resolution?.status === "resolved" ? resolution.tool : undefined;
};

export type XcrunDispatchReview = {
  readonly category: "xcrun_selection" | "xcrun_unavailable" | "xcrun_identity" | "xcrun_dispatch";
  readonly reason: string;
};

export const xcrunDispatchReview = (
  invocation: CommandInvocation,
  environment: readonly ShellAssignment[] = [],
): XcrunDispatchReview | undefined => {
  if (commandBasename(invocation) !== "xcrun") return undefined;
  if (!xcrunDispatchedInvocation(invocation)) return undefined;
  if (!xcrunSelection(invocation.arguments).trusted) {
    return { category: "xcrun_selection", reason: "xcrun uses an untrusted SDK or toolchain selector" };
  }
  const resolution = xcrunToolResolution(invocation, environment);
  if (!resolution || resolution.status === "unavailable") {
    return { category: "xcrun_unavailable", reason: "xcrun cannot resolve the requested tool in the selected Xcode developer directory" };
  }
  if (resolution.status === "untrusted") {
    return { category: "xcrun_identity", reason: "xcrun resolves the requested tool outside the selected Xcode developer directory" };
  }
  const resolved = resolution.tool;
  if (xcrunToolLaunchesHostProcess(resolved.requestedName, resolved.canonicalName, resolved.invocation.arguments)) {
    return { category: "xcrun_dispatch", reason: "xcrun dispatches a tool that can launch a host process" };
  }
  return undefined;
};
