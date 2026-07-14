import { resolve } from "node:path";
import type { CommandInvocation } from "./command-invocation";

export type GitInvocation = {
  readonly subcommand?: string;
  readonly arguments: readonly string[];
  readonly argumentOffset: number;
  readonly unsafeGlobalOptions: readonly string[];
};

const isSafeGitConfig = (value: string): boolean => {
  const separator = value.indexOf("=");
  if (separator < 1) return false;
  const key = value.slice(0, separator).toLowerCase();
  const setting = value.slice(separator + 1);
  if (key === "user.signingkey") return setting.length > 0;
  if (key === "commit.gpgsign") return /^(?:1|on|true|yes)$/iu.test(setting);
  if (key === "gpg.format") return setting.toLowerCase() === "openpgp";
  return false;
};

export const parseGitInvocation = (invocation: CommandInvocation): GitInvocation => {
  const args = invocation.arguments;
  const unsafeGlobalOptions: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) break;
    if (argument === "-C") {
      index += 1;
      continue;
    }
    if (/^-C.+/u.test(argument)) continue;
    if (["--git-dir", "--work-tree", "--namespace"].includes(argument)) {
      unsafeGlobalOptions.push(argument);
      index += 1;
      continue;
    }
    if (/^--(?:git-dir|work-tree|namespace)=/u.test(argument)) {
      unsafeGlobalOptions.push(argument);
      continue;
    }
    if (argument === "-c") {
      const value = args[index + 1] ?? "";
      if (!isSafeGitConfig(value)) unsafeGlobalOptions.push(`-c ${value}`.trim());
      index += 1;
      continue;
    }
    if (/^-c.+/u.test(argument)) {
      if (!isSafeGitConfig(argument.slice(2))) unsafeGlobalOptions.push(argument);
      continue;
    }
    if (["--no-pager", "--no-optional-locks", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs"].includes(argument)) {
      continue;
    }
    if (argument === "-p" || argument === "--paginate" || argument.startsWith("--exec-path") || argument.startsWith("--config-env")) {
      unsafeGlobalOptions.push(argument);
      if ((argument === "--config-env" || argument === "--exec-path") && args[index + 1] && !args[index + 1]?.startsWith("-")) index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      if (["--help", "--version"].includes(argument)) {
        return { subcommand: argument, arguments: args.slice(index + 1), argumentOffset: index + 1, unsafeGlobalOptions };
      }
      unsafeGlobalOptions.push(argument);
      return { arguments: [], argumentOffset: index + 1, unsafeGlobalOptions };
    }
    return { subcommand: argument, arguments: args.slice(index + 1), argumentOffset: index + 1, unsafeGlobalOptions };
  }
  return { arguments: [], argumentOffset: args.length, unsafeGlobalOptions };
};

export const gitEffectiveCwd = (invocation: CommandInvocation, cwd: string): string => {
  const parsed = parseGitInvocation(invocation);
  const globals = invocation.arguments.slice(0, Math.max(0, parsed.argumentOffset - 1));
  let directory = cwd;
  for (let index = 0; index < globals.length; index += 1) {
    const argument = globals[index] ?? "";
    if (argument === "-C") {
      const value = globals[index + 1];
      if (value) directory = resolve(directory, value);
      index += 1;
      continue;
    }
    const attached = argument.match(/^-C(.+)$/u)?.[1];
    if (attached) directory = resolve(directory, attached);
  }
  return directory;
};
