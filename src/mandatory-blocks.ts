import { homedir } from "node:os";
import { commandArguments, commandBasename, type CommandInvocation } from "./command-invocation";
import { guardFinding, type GuardFinding } from "./guard-types";
import { developerToolReadsFiles } from "./developer-tool-guards";
import {
  evaluateRedirectionGuard,
  invocationReferencesSensitivePath,
  isSensitivePathValue,
  jqPrograms,
  mayMatchSensitivePath,
  searchMayReadSensitiveFiles,
} from "./path-safety";
import { shellInputInvocations } from "./shell-invocation";
import type { ShellSegment } from "./types";

const withoutSingleQuotedText = (source: string): string => {
  let output = "";
  let inSingleQuote = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (!inSingleQuote && char === "\\") {
      output += "  ";
      index += 1;
    } else if (char === "'") {
      inSingleQuote = !inSingleQuote;
      output += " ";
    } else output += inSingleQuote ? " " : char;
  }
  return output;
};

const directSensitiveArgument = (invocation: CommandInvocation): boolean => {
  const name = commandBasename(invocation);
  if (name !== "xcodebuild" && !developerToolReadsFiles(name)) return false;
  return commandArguments(invocation).some((argument) => {
    const value = argument.value.startsWith("@") ? argument.value.slice(1) : argument.value;
    const raw = argument.raw.startsWith("@") ? argument.raw.slice(1) : argument.raw;
    return isSensitivePathValue(value) || mayMatchSensitivePath({ ...argument, raw, value });
  });
};

const containsSensitivePath = (invocation: CommandInvocation, cwd: string): boolean =>
  invocationReferencesSensitivePath(invocation) || searchMayReadSensitiveFiles(invocation, cwd) ||
  directSensitiveArgument(invocation);

const expandsSecret = (segment: ShellSegment): boolean =>
  /\$(?:\{)?[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN))[A-Za-z0-9_]*(?:\})?/u.test(
    withoutSingleQuotedText(segment.source),
  );

const recursiveDeleteTarget = (target: string): boolean => {
  const home = homedir();
  const normalized = target.replace(/^\/+/u, "/").replace(/\/{2,}/gu, "/");
  return normalized === "/" || (/^\//u.test(normalized) && /[*?[{]/u.test(normalized)) ||
    normalized === "." || normalized === ".." || normalized.startsWith("../") ||
    /^(?:~|\$HOME)(?:\/|$)/u.test(normalized) || normalized === home || normalized.startsWith(`${home}/`) ||
    /^\/(?:Applications|Library|System|Users|Volumes|bin|dev|etc|home|opt|private|root|sbin|tmp|usr|var)(?:\/|$)/u.test(normalized);
};

export const evaluateCommonBlock = (
  segment: ShellSegment,
  invocation: CommandInvocation,
  cwd: string,
): GuardFinding | undefined => {
  const name = commandBasename(invocation);
  const args = invocation.arguments;
  const redirection = evaluateRedirectionGuard(segment.redirections, cwd);
  if (redirection?.decision === "block") return redirection;
  if (containsSensitivePath(invocation, cwd)) return guardFinding("block", "credential_path", "references a file that commonly contains credentials or approval policy");
  if (shellInputInvocations(invocation).some((input) => containsSensitivePath(input, cwd))) {
    return guardFinding("block", "credential_path", "shell script input references a file that commonly contains credentials or approval policy");
  }
  if (expandsSecret(segment)) return guardFinding("block", "secret_expansion", "expands an environment variable whose name looks secret-bearing");
  if (name === "jq" && jqPrograms(invocation).some((program) => /(?:\$ENV\b|(?:^|[^A-Za-z0-9_$.])env(?:[^A-Za-z0-9_]|$))/u.test(program))) {
    return guardFinding("block", "environment_dump", "jq environment access can expose API keys and tokens");
  }
  if (name === "sudo") return guardFinding("block", "sudo", "sudo should not run unattended");
  if (["env", "printenv", "set"].includes(name)) return guardFinding("block", "environment_dump", "environment dumps often expose API keys and tokens");
  if (name === "ipatool") return guardFinding("block", "environment_dump", "ipatool can print the complete process environment on startup or error paths");
  if (name === "security" && ["find-generic-password", "find-internet-password", "dump-keychain"].includes(args[0] ?? "")) {
    return guardFinding("block", "keychain_read", "macOS keychain reads can expose credentials");
  }
  if (name === "rm" && args.some((argument) => /^-(?:[A-Za-z]*[rR][A-Za-z]*|-recursive)$/u.test(argument)) && args.some(recursiveDeleteTarget)) {
    return guardFinding("block", "recursive_delete", "recursive delete targets root, home, or a broad system subtree");
  }
  if ((name === "diskutil" && /^(?:erase|partition|zeroDisk|secureErase)/u.test(args[0] ?? "")) ||
      (name === "dd" && args.some((argument) => /^of=\/dev\//u.test(argument))) || /^(?:mkfs|newfs_)/u.test(name) ||
      (name === "rsync" && args.some((argument) => argument.startsWith("--delete"))) ||
      (["chmod", "chown"].includes(name) && args.includes("-R") && args.some((argument) => argument.startsWith("/")))) {
    return guardFinding("block", "destructive_device", "disk, device, recursive permission, or rsync delete operation is high risk");
  }
  if ((name === "openclaw" && args[0] === "run") || (name === "opencode" && args[0] === "run") ||
      (name === "codex" && args[0] === "exec") || name === "claude") {
    return guardFinding("block", "nested_agent", "nested unattended coding agents can multiply tool execution");
  }
  if ((name === "mcpbridge" && args.includes("run-agent")) ||
      (name === "agent" && !["-h", "--help", "--version", "help", "skills"].includes(args[0] ?? ""))) {
    return guardFinding("block", "nested_agent", "Xcode agent launchers can fetch credentials and execute another coding agent");
  }
  if (name === "yes") return guardFinding("block", "blind_confirmation", "can hang or blindly confirm prompts");
  return undefined;
};
