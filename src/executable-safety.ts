import { constants, accessSync, existsSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, relative, resolve } from "node:path";
import { commandBasename, type CommandInvocation } from "./command-invocation";
import { guardFinding, type GuardFinding } from "./guard-types";

const protectedExecutables = new Set([
  "asc", "axe", "base64", "cat", "cksum", "comm", "cut", "date", "df", "diskutil", "du", "egrep", "fgrep",
  "file", "fmt", "fold", "ffprobe", "gh", "git", "grep", "head", "hdiutil", "id", "join", "jq", "launchctl",
  "log", "ls", "md5", "nl", "paste", "pgrep", "readlink", "realpath", "rg", "security", "shasum", "sim-use",
  "sed", "sleep", "sort", "stat", "strings", "sw_vers", "tail", "tmutil", "tr", "uname", "wc", "which", "whoami",
  "swift", "xcodebuild", "xcodebuildmcp", "xcrun",
]);

const shellBuiltins = new Set(["[", "command", "echo", "false", "printf", "pwd", "test", "true"]);

const trustedRoots = [
  "/bin", "/usr/bin", "/sbin", "/usr/sbin", "/usr/local", "/opt/homebrew", "/opt/local",
  "/Applications/ChatGPT.app/Contents/Resources", "/Applications/OpenCode.app/Contents/Resources",
];

const trustedSearchDirectories = [
  "/bin", "/usr/bin", "/sbin", "/usr/sbin", "/usr/local/bin", "/opt/homebrew/bin", "/opt/local/bin",
  "/Applications/ChatGPT.app/Contents/Resources", "/Applications/OpenCode.app/Contents/Resources",
];

const safelyRealpath = (path: string): string => {
  try {
    return existsSync(path) ? realpathSync(path) : resolve(path);
  } catch (error) {
    if (error instanceof Error) return resolve(path);
    throw error;
  }
};

const within = (root: string, target: string): boolean => {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const executablePath = (commandName: string, cwd: string, pathValue: string): string | undefined => {
  const candidates = commandName.includes("/")
    ? [resolve(cwd, commandName)]
    : [
        ...pathValue.split(delimiter).map((entry) =>
          resolve(entry ? (isAbsolute(entry) ? entry : resolve(cwd, entry)) : cwd, commandName),
        ),
        ...trustedSearchDirectories.map((directory) => resolve(directory, commandName)),
      ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return safelyRealpath(candidate);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
  }
  return undefined;
};

export const evaluateExecutableGuard = (
  invocation: CommandInvocation,
  cwd: string,
  pathValue = process.env["PATH"] ?? "",
): GuardFinding | undefined => {
  const name = commandBasename(invocation);
  const explicitBuiltinPath = shellBuiltins.has(name) && invocation.commandName !== name;
  if ((!protectedExecutables.has(name) && !explicitBuiltinPath) || (shellBuiltins.has(name) && !explicitBuiltinPath)) {
    return undefined;
  }
  const executable = executablePath(invocation.commandName, cwd, pathValue);
  const trusted = executable && trustedRoots.some((root) => within(root, executable));
  if (!trusted) {
    return guardFinding("review", "executable_identity", "command does not resolve to a trusted system executable");
  }
  return undefined;
};
