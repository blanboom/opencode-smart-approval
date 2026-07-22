import { basename, join } from "node:path";
import type { CommandInvocation } from "./command-invocation";

export type RecognizedMutationTargets = {
  readonly ambiguous: boolean;
  readonly exactTargets: readonly string[];
  readonly recognized: true;
};

type PathArgument = {
  readonly dynamic: boolean;
  readonly value: string;
};

const pathArgument = (invocation: CommandInvocation, index: number, value: string): PathArgument => ({
  dynamic: invocation.argumentWords[index]?.expansionFree === false,
  value,
});

const linkMutationTargets = (invocation: CommandInvocation): RecognizedMutationTargets => {
  const operands: PathArgument[] = [];
  let symbolic = false;
  let optionsEnded = false;
  let targetDirectory: PathArgument | undefined;
  let ambiguousOption = false;
  for (let index = 0; index < invocation.arguments.length; index += 1) {
    const argument = invocation.arguments[index];
    if (!argument) continue;
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && argument === "--symbolic") {
      symbolic = true;
      continue;
    }
    if (!optionsEnded && (argument === "-t" || argument === "--target-directory")) {
      const value = invocation.arguments[index + 1];
      if (!value) {
        ambiguousOption = true;
        continue;
      }
      targetDirectory = pathArgument(invocation, index + 1, value);
      index += 1;
      continue;
    }
    if (!optionsEnded && argument.startsWith("--target-directory=")) {
      targetDirectory = pathArgument(invocation, index, argument.slice("--target-directory=".length));
      continue;
    }
    if (!optionsEnded && /^-[^-]/u.test(argument)) {
      const flags = argument.slice(1);
      const targetIndex = flags.indexOf("t");
      if (targetIndex >= 0) {
        symbolic ||= flags.slice(0, targetIndex).includes("s");
        const attached = flags.slice(targetIndex + 1);
        if (attached.length > 0) {
          targetDirectory = pathArgument(invocation, index, attached);
        } else {
          const value = invocation.arguments[index + 1];
          if (value) {
            targetDirectory = pathArgument(invocation, index + 1, value);
            index += 1;
          } else {
            ambiguousOption = true;
          }
        }
      } else {
        symbolic ||= flags.includes("s");
      }
      continue;
    }
    if (!optionsEnded && argument.startsWith("-")) continue;
    operands.push(pathArgument(invocation, index, argument));
  }

  const sources = targetDirectory ? operands : operands.slice(0, -1);
  const explicitDestination = targetDirectory ?? operands.at(-1);
  const destinations = explicitDestination
    ? [
        explicitDestination,
        ...sources.map((source) => ({
          dynamic: explicitDestination.dynamic,
          value: join(explicitDestination.value, basename(source.value)),
        })),
      ]
    : [];
  return {
    ambiguous: ambiguousOption
      || destinations.some((target) => target.dynamic)
      || (!symbolic && sources.some((source) => source.dynamic)),
    exactTargets: [
      ...(!symbolic ? sources.map((source) => source.value) : []),
      ...destinations.map((target) => target.value),
    ],
    recognized: true,
  };
};

const touchMutationTargets = (invocation: CommandInvocation): RecognizedMutationTargets => {
  const targets: PathArgument[] = [];
  let optionsEnded = false;
  for (let index = 0; index < invocation.arguments.length; index += 1) {
    const argument = invocation.arguments[index];
    if (!argument) continue;
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (argument === "-r" || argument === "--reference")) {
      index += 1;
      continue;
    }
    if (!optionsEnded && (argument.startsWith("--reference=") || /^-r.+/u.test(argument))) continue;
    if (!optionsEnded && argument.startsWith("-")) continue;
    targets.push(pathArgument(invocation, index, argument));
  }
  return {
    ambiguous: targets.some((target) => target.dynamic),
    exactTargets: targets.map((target) => target.value),
    recognized: true,
  };
};

export { linkMutationTargets, touchMutationTargets };
