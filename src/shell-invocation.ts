import {
  commandArguments,
  commandBasename,
  type CommandArgument,
  type CommandInvocation,
} from "./command-invocation";

export const shellNames = new Set([
  "ash", "bash", "dash", "fish", "ksh", "mksh", "powershell", "pwsh", "sh", "zsh",
]);

const readerInvocation = (argument: CommandArgument): CommandInvocation => ({
  commandName: "cat",
  arguments: [argument.value],
  rawArguments: [argument.raw],
  argumentOffset: 0,
  reviewReasons: [],
});

export const shellInputInvocations = (invocation: CommandInvocation): readonly CommandInvocation[] => {
  if (!shellNames.has(commandBasename(invocation))) return [];
  const inputs: CommandInvocation[] = [];
  const args = commandArguments(invocation);
  let options = true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (options && ["--rcfile", "--init-file"].includes(argument.value)) {
      const input = args[index + 1];
      if (input) inputs.push(readerInvocation(input));
      index += 1;
      continue;
    }
    if (options && /^(?:--rcfile|--init-file)=/u.test(argument.value)) {
      const value = argument.value.slice(argument.value.indexOf("=") + 1);
      inputs.push(readerInvocation({ raw: value, value }));
      continue;
    }
    if (options && ["-O", "-o"].includes(argument.value)) {
      index += 1;
      continue;
    }
    if (options && /^-[^-]*[cs]/u.test(argument.value)) return inputs;
    if (options && argument.value === "--") {
      options = false;
      continue;
    }
    if (options && argument.value.startsWith("-")) continue;
    inputs.push(readerInvocation(argument));
    return inputs;
  }
  return inputs;
};

export const shellNeedsExecutionReview = (invocation: CommandInvocation): boolean => {
  if (!shellNames.has(commandBasename(invocation))) return false;
  const args = invocation.arguments;
  return !args.some((argument) => ["--help", "--version"].includes(argument));
};
