import { existsSync } from "node:fs";
import type { CommandInvocation } from "./command-invocation";
import { commandBasename } from "./command-invocation";
import { guardFinding, type GuardFinding } from "./guard-types";
import { allowedReadRoots, canonicalPath, temporaryRoots, withinPath } from "./path-boundary";
import { isReaderCommand, pathArgumentGroupsFor, sensitivePathArgumentsFor } from "./reader-arguments";
import {
  expandedPath,
  globFinding,
  isSensitivePathValue,
  literalTilde,
  mayMatchSensitivePath,
} from "./reader-paths";
import type { ShellRedirection } from "./types";

export const invocationReferencesSensitivePath = (invocation: CommandInvocation): boolean => {
  if (!isReaderCommand(invocation)) return false;
  const gitSyntax = commandBasename(invocation) === "git";
  return sensitivePathArgumentsFor(invocation).some((argument) =>
    !literalTilde(argument) && (isSensitivePathValue(argument.value, gitSyntax) || mayMatchSensitivePath(argument, gitSyntax))
  );
};

export const evaluateReaderPathGuard = (
  invocation: CommandInvocation,
  cwd: string,
): GuardFinding | undefined => {
  if (!isReaderCommand(invocation)) return undefined;
  const roots = allowedReadRoots(cwd);
  const paths = pathArgumentGroupsFor(invocation);
  const sensitiveArguments = new Set(paths.sensitive);
  for (const argument of paths.all) {
    const expanded = expandedPath(argument, cwd);
    if (!expanded) {
      return guardFinding("review", "external_read", "file-reading command uses an unresolved tilde expansion");
    }
    const glob = globFinding(argument, cwd, roots);
    if (glob === "sensitive") {
      return guardFinding("block", "credential_path", "resolved input targets a file that commonly contains credentials or approval policy");
    }
    if (glob) {
      return guardFinding("review", "external_read", `file-reading glob exceeded the traversal bound or ${glob === "escape" ? "escaped through a symlink" : "could not be bounded"}`);
    }
    const pathExists = existsSync(expanded);
    const target = canonicalPath(expanded);
    if (sensitiveArguments.has(argument) && (!literalTilde(argument) || pathExists) && isSensitivePathValue(target)) {
      return guardFinding("block", "credential_path", "resolved input targets a file that commonly contains credentials or approval policy");
    }
    if (!roots.some((root) => withinPath(root, target))) {
      return guardFinding("review", "external_read", "file-reading command targets a path outside the working directory or system temporary directory");
    }
  }
  return undefined;
};

export const evaluateRedirectionGuard = (
  redirections: readonly ShellRedirection[],
  cwd: string,
): GuardFinding | undefined => {
  for (const redirection of redirections) {
    const { operator, target } = redirection;
    if ([">&", "<&"].includes(operator) && (target.value === "-" || /^\d+$/u.test(target.value))) continue;
    if (target.value === "/dev/null") continue;
    const invocation: CommandInvocation = {
      commandName: "cat",
      arguments: [target.value],
      rawArguments: [target.raw],
      argumentOffset: 0,
      reviewReasons: [],
    };
    if (invocationReferencesSensitivePath(invocation)) {
      return guardFinding("block", "credential_path", "redirection targets a file that commonly contains credentials or approval policy");
    }
    const expanded = expandedPath(target, cwd);
    if (!expanded) return guardFinding("review", "redirection", "redirection uses an unresolved tilde expansion");
    const canonical = canonicalPath(expanded);
    if (isSensitivePathValue(canonical)) {
      return guardFinding("block", "credential_path", "redirection resolves to a file that commonly contains credentials or approval policy");
    }
    if (operator === "<") {
      const readGuard = evaluateReaderPathGuard(invocation, cwd);
      if (readGuard) return readGuard;
      continue;
    }
    const glob = globFinding(target, cwd, temporaryRoots());
    if (glob === "sensitive") {
      return guardFinding("block", "credential_path", "redirection glob resolves to a file that commonly contains credentials or approval policy");
    }
    if (glob) {
      return guardFinding("review", "redirection", "output redirection glob escapes a temporary directory or exceeds the traversal bound");
    }
    if (!temporaryRoots().some((root) => withinPath(root, canonical))) {
      return guardFinding("review", "redirection", "output redirection writes outside a system temporary directory");
    }
  }
  return undefined;
};
