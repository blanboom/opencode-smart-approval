import {
  commandArguments,
  type CommandArgument,
  type CommandInvocation,
} from "./command-invocation";
import { guardFinding, type GuardFinding } from "./guard-types";

type SedAnalysis = {
  readonly paths: readonly CommandArgument[];
  readonly scripts: readonly string[];
  readonly quiet: boolean;
  readonly unsupported?: string;
};

const displayProgram = /^\s*(?:\d+|\$)(?:\s*,\s*(?:\d+|\$))?\s*p\s*;?\s*$/u;
const safeShortFlags = /^[EHalnru]*$/u;

const analyzeSed = (invocation: CommandInvocation): SedAnalysis => {
  const pairs = commandArguments(invocation);
  const paths: CommandArgument[] = [];
  const scripts: string[] = [];
  let quiet = false;
  let explicitScript = false;
  let options = true;
  for (let index = 0; index < pairs.length; index += 1) {
    const argument = pairs[index];
    if (!argument) continue;
    if (options && argument.value === "--") {
      options = false;
      continue;
    }
    if (argument.value === "-" && (explicitScript || scripts.length > 0)) continue;
    if (options && ["--quiet", "--silent"].includes(argument.value)) {
      quiet = true;
      continue;
    }
    if (options && ["-e", "--expression"].includes(argument.value)) {
      const script = pairs[index + 1];
      if (!script) return { paths, scripts, quiet, unsupported: "sed expression option is missing its program" };
      scripts.push(script.value);
      explicitScript = true;
      index += 1;
      continue;
    }
    const longExpression = options ? argument.value.match(/^--expression=(.*)$/u)?.[1] : undefined;
    if (longExpression !== undefined) {
      scripts.push(longExpression);
      explicitScript = true;
      continue;
    }
    if (options && /^-[^-]/u.test(argument.value)) {
      const flags = argument.value.slice(1);
      const expressionIndex = flags.indexOf("e");
      if (expressionIndex >= 0) {
        const prefix = flags.slice(0, expressionIndex);
        if (!safeShortFlags.test(prefix) || flags.slice(expressionIndex + 1).includes("e")) {
          return { paths, scripts, quiet, unsupported: "sed uses an unsupported short option cluster" };
        }
        quiet ||= prefix.includes("n");
        const attached = flags.slice(expressionIndex + 1);
        const script = attached ? { raw: attached, value: attached } : pairs[index + 1];
        if (!script) return { paths, scripts, quiet, unsupported: "sed -e is missing its program" };
        scripts.push(script.value);
        explicitScript = true;
        if (!attached) index += 1;
        continue;
      }
      if (!safeShortFlags.test(flags)) {
        return { paths, scripts, quiet, unsupported: "sed option can read a script or modify a file" };
      }
      quiet ||= flags.includes("n");
      continue;
    }
    if (options && argument.value.startsWith("-")) {
      return { paths, scripts, quiet, unsupported: "sed uses an unsupported option" };
    }
    if (!explicitScript && scripts.length === 0) scripts.push(argument.value);
    else paths.push(argument);
  }
  return { paths, scripts, quiet };
};

export const sedPathArguments = (invocation: CommandInvocation): readonly CommandArgument[] =>
  analyzeSed(invocation).paths;

export const evaluateSedGuard = (invocation: CommandInvocation): GuardFinding | undefined => {
  const analysis = analyzeSed(invocation);
  if (
    analysis.unsupported ||
    !analysis.quiet ||
    analysis.scripts.length === 0 ||
    analysis.scripts.some((script) => !displayProgram.test(script))
  ) {
    return guardFinding(
      "review",
      "sed_program",
      analysis.unsupported ?? "sed automatic approval is limited to quiet numeric-range print programs",
    );
  }
  return undefined;
};
