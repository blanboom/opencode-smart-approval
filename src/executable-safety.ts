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

const trustedCanonicalAliases = new Map<string, ReadonlySet<string>>([
  ["egrep", new Set(["grep"])],
  ["fgrep", new Set(["grep"])],
  ["swift", new Set(["swift-driver"])],
]);

const trustedRoots = [
  "/bin", "/usr/bin", "/sbin", "/usr/sbin", "/usr/local", "/opt/homebrew", "/opt/local",
  "/usr/share/swift/usr/bin",
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

type ExecutablePath = {
  readonly candidate: string;
  readonly canonical: string;
};

const executablePath = (commandName: string, cwd: string, pathValue: string): ExecutablePath | undefined => {
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
      return { candidate, canonical: safelyRealpath(candidate) };
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
  if (!executable) {
    return guardFinding("review", "executable_unavailable", "command does not resolve to an installed system executable");
  }
  const candidateTrusted = trustedRoots.some((root) => within(root, executable.candidate));
  const canonicalTrusted = trustedRoots.some((root) => within(root, executable.canonical));
  const canonicalName = commandBasename({ ...invocation, commandName: executable.canonical });
  const identityTrusted = canonicalName === name || trustedCanonicalAliases.get(name)?.has(canonicalName) === true;
  if (!identityTrusted) {
    return guardFinding("block", "executable_identity", "protected command name resolves to a different executable identity");
  }
  if (!candidateTrusted || !canonicalTrusted) {
    return guardFinding("review", "executable_identity", "command path or canonical executable identity is not trusted");
  }
  return undefined;
};
