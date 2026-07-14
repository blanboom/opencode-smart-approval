import {
  commandArguments,
  type CommandArgument,
  type CommandInvocation,
} from "./command-invocation";
import { rawAttachedValue } from "./short-options";

export const jqPrograms = (invocation: CommandInvocation): readonly string[] => {
  const programs: string[] = [];
  const args = invocation.arguments;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (["--arg", "--argjson", "--argfile", "--rawfile", "--slurpfile"].includes(argument)) {
      index += 2;
      continue;
    }
    if (["-L", "-f", "--from-file"].includes(argument)) {
      index += 1;
      continue;
    }
    if (argument === "--run-tests") return [];
    if (/^--run-tests=|^(?:-L|-f).+|^--from-file=.+/u.test(argument)) continue;
    if (argument.startsWith("-")) continue;
    programs.push(argument);
    break;
  }
  return programs;
};

export const jqPathArguments = (invocation: CommandInvocation): readonly CommandArgument[] => {
  const paths: CommandArgument[] = [];
  const pairs = commandArguments(invocation);
  const positionalValues = invocation.arguments.some((argument) => ["--args", "--jsonargs"].includes(argument));
  let programFound = false;
  for (let index = 0; index < pairs.length; index += 1) {
    const argument = pairs[index];
    if (!argument) continue;
    if (["--arg", "--argjson"].includes(argument.value)) {
      index += 2;
      continue;
    }
    if (["--argfile", "--rawfile", "--slurpfile"].includes(argument.value)) {
      const path = pairs[index + 2];
      if (path) paths.push(path);
      index += 2;
      continue;
    }
    if (argument.value === "-L") {
      const path = pairs[index + 1];
      if (path) paths.push(path);
      index += 1;
      continue;
    }
    if (["-f", "--from-file"].includes(argument.value)) {
      const path = pairs[index + 1];
      if (path) paths.push(path);
      programFound = true;
      index += 1;
      continue;
    }
    if (argument.value === "--run-tests") {
      const path = pairs[index + 1];
      if (path) paths.push(path);
      break;
    }
    const testPath = argument.value.match(/^--run-tests=(.+)$/u)?.[1];
    if (testPath) {
      paths.push({ raw: rawAttachedValue(argument, testPath), value: testPath });
      break;
    }
    const compactPath = argument.value.match(/^(?:-L|-f|--from-file=)(.+)$/u)?.[1];
    if (compactPath) {
      paths.push({ raw: rawAttachedValue(argument, compactPath), value: compactPath });
      if (!argument.value.startsWith("-L")) programFound = true;
      continue;
    }
    if (argument.value.startsWith("-")) continue;
    if (!programFound) programFound = true;
    else if (!positionalValues) paths.push(argument);
  }
  return paths;
};
