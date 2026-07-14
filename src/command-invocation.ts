import { basename } from "node:path";
import type { ShellSegment } from "./types";

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
    const argument = invocation.arguments[index] ?? "";
    if (argument === "-v" || argument === "-V") return undefined;
    if (argument === "-p" || argument === "--") continue;
    if (argument.startsWith("-")) return undefined;
    return advance(invocation, index);
  }
  return undefined;
};

const envTarget = (invocation: CommandInvocation): CommandInvocation | undefined => {
  for (let index = 0; index < invocation.arguments.length; index += 1) {
    const argument = invocation.arguments[index] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(argument) || argument === "--" || argument === "-i" || argument === "--ignore-environment") {
      continue;
    }
    if (argument === "-u" || argument === "--unset") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--unset=")) continue;
    if (argument.startsWith("-")) return undefined;
    return advance(invocation, index);
  }
  return undefined;
};

const firstArgumentTarget = (
  invocation: CommandInvocation,
  reason?: string,
): CommandInvocation | undefined => advance(invocation, 0, reason);

const execTarget = (invocation: CommandInvocation): CommandInvocation | undefined => {
  for (let index = 0; index < invocation.arguments.length; index += 1) {
    const argument = invocation.arguments[index] ?? "";
    if (argument === "-a") {
      index += 1;
      continue;
    }
    if (argument === "--" || /^-[cl]+$/u.test(argument)) continue;
    if (argument.startsWith("-")) return undefined;
    return advance(invocation, index, "exec dispatch replaces the current shell process");
  }
  return undefined;
};

const timeTarget = (invocation: CommandInvocation): CommandInvocation | undefined => {
  for (let index = 0; index < invocation.arguments.length; index += 1) {
    const argument = invocation.arguments[index] ?? "";
    if (["-o", "--output", "-f", "--format"].includes(argument)) {
      index += 1;
      continue;
    }
    if (argument === "--" || /^(?:-o.+|--output=.+|-f.+|--format=.+|-[ahlpv]+)$/u.test(argument)) continue;
    if (argument.startsWith("-")) return undefined;
    return advance(invocation, index);
  }
  return undefined;
};

const sudoTarget = (invocation: CommandInvocation): CommandInvocation | undefined => {
  const optionsWithValues = new Set([
    "-C", "-D", "-g", "-h", "-p", "-r", "-t", "-u",
    "--chdir", "--close-from", "--group", "--host", "--prompt", "--role", "--type", "--user",
  ]);
  for (let index = 0; index < invocation.arguments.length; index += 1) {
    const argument = invocation.arguments[index] ?? "";
    if (argument === "--") return advance(invocation, index + 1);
    if (optionsWithValues.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("--") && argument.includes("=")) continue;
    if (argument.startsWith("-")) continue;
    return advance(invocation, index);
  }
  return undefined;
};

export const effectiveInvocation = (initial: CommandInvocation): CommandInvocation => {
  let invocation = initial;
  for (let depth = 0; depth < 8; depth += 1) {
    const name = commandBasename(invocation);
    const target = name === "command"
      ? commandTarget(invocation)
      : name === "exec"
        ? execTarget(invocation)
        : name === "env"
          ? envTarget(invocation)
          : name === "time"
            ? timeTarget(invocation)
            : name === "builtin" || name === "busybox"
              ? firstArgumentTarget(invocation, `${name} dispatch requires review`)
              : name === "sudo"
                ? sudoTarget(invocation)
              : name === "nice" || name === "nohup"
                ? firstArgumentTarget(invocation)
                : undefined;
    if (!target) return invocation;
    invocation = target;
  }
  return { ...invocation, reviewReasons: [...invocation.reviewReasons, "wrapper nesting limit exceeded"] };
};
