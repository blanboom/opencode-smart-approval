import { basename } from "node:path";
import type { ShellSegment } from "./types";
import { canonicalPath, temporaryRoots, withinPath } from "./path-boundary";

export type CommandArgument = {
  readonly raw: string;
  readonly value: string;
  readonly resolutionBase?: string;
};

export type CommandInvocation = {
  readonly commandName: string;
  readonly arguments: readonly string[];
  readonly rawArguments: readonly string[];
  readonly argumentOffset: number;
  readonly reviewReasons: readonly string[];
};

export const commandBasename = (invocation: Pick<CommandInvocation, "commandName">): string =>
  basename(invocation.commandName);

export const invocationFromSegment = (segment: ShellSegment): CommandInvocation => ({
  commandName: segment.commandName,
  arguments: segment.arguments,
  rawArguments: segment.rawArguments,
  argumentOffset: 0,
  reviewReasons: [],
});

export const commandArguments = (invocation: CommandInvocation): readonly CommandArgument[] =>
  invocation.arguments.map((value, index) => ({ raw: invocation.rawArguments[index] ?? value, value }));

const advance = (
  invocation: CommandInvocation,
  index: number,
  reviewReason?: string,
): CommandInvocation | undefined => {
  const commandName = invocation.arguments[index];
  if (!commandName) return undefined;
  return {
    commandName,
    arguments: invocation.arguments.slice(index + 1),
    rawArguments: invocation.rawArguments.slice(index + 1),
    argumentOffset: invocation.argumentOffset + index + 1,
    reviewReasons: reviewReason
      ? [...invocation.reviewReasons, reviewReason]
      : invocation.reviewReasons,
  };
};

const commandTarget = (invocation: CommandInvocation): CommandInvocation | undefined => {
  for (let index = 0; index < invocation.arguments.length; index += 1) {
    const argument = invocation.arguments[index];
    if (argument === "-v" || argument === "-V") return undefined;
    if (argument === "-p" || argument === "--") continue;
    if (argument?.startsWith("-")) return undefined;
    return advance(invocation, index);
  }
  return undefined;
};

const execTarget = (invocation: CommandInvocation): CommandInvocation | undefined => {
  for (let index = 0; index < invocation.arguments.length; index += 1) {
    const argument = invocation.arguments[index];
    if (argument === "-a") {
      index += 1;
      continue;
    }
    if (argument === "--" || /^-[cl]+$/u.test(argument ?? "")) continue;
    if (argument?.startsWith("-")) return undefined;
    return advance(invocation, index, "exec dispatch replaces the current shell process");
  }
  return undefined;
};

const firstArgumentTarget = (
  invocation: CommandInvocation,
  reason: string,
): CommandInvocation | undefined => advance(invocation, 0, reason);

const iosCommands = new Set(["asc", "axe", "sim-use", "swift", "xcodebuild", "xcodebuildmcp", "xcrun"]);

const trustedTemporaryValue = (value: string): boolean => {
  if (!value.startsWith("/")) return false;
  const target = canonicalPath(value);
  return temporaryRoots().some((root) => withinPath(root, target));
};

const trustedDeveloperDirectory = (value: string): boolean => {
  if (!value.startsWith("/")) return false;
  const target = canonicalPath(value);
  return /^\/Applications\/Xcode[^/]*\.app\/Contents\/Developer\/?$/u.test(target) ||
    /^\/Library\/Developer\/CommandLineTools\/?$/u.test(target);
};

export const environmentAssignmentNeedsReview = (
  name: string,
  commandName: string,
  value: string,
): boolean => {
  const command = basename(commandName);
  if (/^(?:PATH|CDPATH|ENV|BASH_ENV|ZDOTDIR|SHELLOPTS|BASHOPTS|IFS|LD_.+|DYLD_.+|GIT_.+|GH_.+|GNUPGHOME|RIPGREP_CONFIG_PATH|SDKROOT|TOOLCHAINS|TOOLCHAINS_DIR|XCODE_XCCONFIG_FILE|XDG_CONFIG_HOME|NODE_OPTIONS|BUN_OPTIONS|PYTHONPATH|RUBYLIB|PERL5LIB|FFREPORT|CC|CXX|CPP|AR|AS|LD|NM|RANLIB|STRIP|SWIFT_EXEC|SWIFTC_EXEC|SWIFT_EXEC_MANIFEST|SWIFT_API_DIGESTER|SWIFT_FORMAT|SWIFT_SYMBOLGRAPH_EXTRACT|SWIFT_ABI_(?:CHECKER|GENERATION)_TOOL|SWIFT_DRIVER_.+|SWIFTPM_CUSTOM_(?:BINDIR|BIN_DIR|LIBS_DIR)|SWIFTPM_UNSAFE_FLAGS|COMPILER_PATH|GCC_EXEC_PREFIX|CCC_ADD_ARGS|CCC_OVERRIDE_OPTIONS|CLANG_CONFIG_PATH|CLANG_CONFIG_FILE_(?:SYSTEM|USER)_DIR|LLVM_CACHE_PLUGIN_PATH|LLVM_SYMBOLIZER_PATH|LIBLTO_PATH|OTOOL_PATH|SOURCEKIT_PATH|SOURCEKIT_TOOLCHAIN_PATH|COMMAND_YACC|DOCC_LINK_RESOLVER_EXECUTABLE|CPATH|C_INCLUDE_PATH|CPLUS_INCLUDE_PATH|OBJC_INCLUDE_PATH|LIBRARY_PATH|BISON_PKGDATADIR|M4)$/u.test(name)) {
    return true;
  }
  if (["EDITOR", "VISUAL", "PAGER", "MANPAGER"].includes(name)) return ["git", "gh"].includes(command);
  if (["LESSOPEN", "LESSCLOSE"].includes(name)) return true;
  if (["TMPDIR", "TMP", "TEMP"].includes(name)) return !trustedTemporaryValue(value);
  if (["HOME", "CFFIXED_USER_HOME"].includes(name)) {
    return !iosCommands.has(command) || !trustedTemporaryValue(value);
  }
  if (name === "DEVELOPER_DIR") return !iosCommands.has(command) || !trustedDeveloperDirectory(value);
  return false;
};

const envTarget = (invocation: CommandInvocation): CommandInvocation | undefined => {
  const assignments: Array<{ readonly name: string; readonly value: string }> = [];
  for (let index = 0; index < invocation.arguments.length; index += 1) {
    const argument = invocation.arguments[index] ?? "";
    if (argument === "--") continue;
    const assignment = argument.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (assignment?.[1] !== undefined) {
      assignments.push({ name: assignment[1], value: assignment[2] ?? "" });
      continue;
    }
    if (["-i", "--ignore-environment"].includes(argument)) continue;
    if (["-u", "--unset"].includes(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("--unset=")) continue;
    if (argument.startsWith("-")) return undefined;
    const target = advance(invocation, index);
    const risky = target
      ? assignments.filter((entry) =>
          environmentAssignmentNeedsReview(entry.name, target.commandName, entry.value) ||
          (commandBasename(target) === "xcrun" && entry.name === "DEVELOPER_DIR")
        )
      : [];
    return target && risky.length > 0
      ? { ...target, reviewReasons: [...target.reviewReasons, `environment wrapper changes ${risky.map((entry) => entry.name).join(", ")}`] }
      : target;
  }
  return undefined;
};

export const xcrunDispatchedInvocation = (invocation: CommandInvocation): CommandInvocation | undefined => {
  if (commandBasename(invocation) !== "xcrun") return undefined;
  let findOnly = false;
  for (let index = 0; index < invocation.arguments.length; index += 1) {
    const argument = invocation.arguments[index] ?? "";
    if (["-f", "--find"].includes(argument)) {
      findOnly = true;
      continue;
    }
    if (["-r", "--run"].includes(argument)) {
      findOnly = false;
      continue;
    }
    if (["--sdk", "-sdk", "--toolchain", "-toolchain"].includes(argument)) {
      index += 1;
      continue;
    }
    if (/^--(?:sdk|toolchain)=/u.test(argument) || argument === "--" || argument.startsWith("-")) continue;
    return findOnly ? undefined : advance(invocation, index);
  }
  return undefined;
};

export const dispatchedInvocationForGuards = (invocation: CommandInvocation): CommandInvocation | undefined => {
  const target = xcrunDispatchedInvocation(invocation);
  return target ? effectiveInvocation(target) : undefined;
};

const timeTarget = (invocation: CommandInvocation): CommandInvocation | undefined => {
  let reason: string | undefined;
  for (let index = 0; index < invocation.arguments.length; index += 1) {
    const argument = invocation.arguments[index] ?? "";
    if (argument === "--") continue;
    if (["-o", "--output"].includes(argument)) {
      reason = "time output option writes a file";
      index += 1;
      continue;
    }
    if (/^(?:-o.+|--output=.+)$/u.test(argument)) {
      reason = "time output option writes a file";
      continue;
    }
    if (["-f", "--format"].includes(argument)) {
      index += 1;
      continue;
    }
    if (/^(?:-f.+|--format=.+)$/u.test(argument) || /^-[ahlpv]+$/u.test(argument)) continue;
    if (argument.startsWith("-")) return undefined;
    return advance(invocation, index, reason);
  }
  return undefined;
};

export const effectiveInvocation = (initial: CommandInvocation): CommandInvocation => {
  let invocation = initial;
  for (let depth = 0; depth < 8; depth += 1) {
    const name = commandBasename(invocation);
    const target =
      name === "command"
        ? commandTarget(invocation)
        : name === "exec"
          ? execTarget(invocation)
          : name === "builtin"
            ? firstArgumentTarget(invocation, "shell builtin dispatch requires review")
            : name === "busybox"
              ? firstArgumentTarget(invocation, "BusyBox applet dispatch requires review")
              : name === "env"
                ? envTarget(invocation)
                : name === "time"
                  ? timeTarget(invocation)
              : undefined;
    if (!target) return invocation;
    invocation = target;
  }
  return { ...invocation, reviewReasons: [...invocation.reviewReasons, "wrapper nesting limit exceeded"] };
};
