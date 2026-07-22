import { basename, resolve } from "node:path";
import { outputOptionTargets, type OutputTargetAnalysis } from "./output-option-targets";
import type { ExecutionAssignment, ExecutionTargetKind, ShellWord, ShellWrapper } from "./types";

export type WrapperInvocationView = {
  readonly commandName: string;
  readonly arguments: readonly string[];
  readonly argumentWords: readonly ShellWord[];
  readonly targetKind: ExecutionTargetKind;
  readonly executionCwd: string;
};

export type WrapperTarget = {
  readonly index: number;
  readonly targetKind: ExecutionTargetKind;
  readonly executionCwd: string;
  readonly reason?: string;
  readonly envAssignments?: readonly ExecutionAssignment[];
};

const builtinNames = new Set([".", "builtin", "cd", "command", "exec", "source"]);
const busyboxApplets = new Set(["ash", "sh"]);
const externalWrappers = new Set(["busybox", "env", "nice", "nohup", "sudo", "time"]);
const builtinWrappers = new Set(["builtin", "command", "exec"]);
const timeOutputOptions = new Set(["-o", "--output"]);

export const directTargetKind = (word: ShellWord): ExecutionTargetKind =>
  word.expansionFree && builtinNames.has(word.value) ? "builtin" : "external";

const wrapperName = (invocation: WrapperInvocationView): string | undefined => {
  const name = basename(invocation.commandName);
  if (invocation.targetKind === "external" && externalWrappers.has(name)) return name;
  if (invocation.targetKind === "builtin" && builtinWrappers.has(name)) return name;
  return undefined;
};

export const isRecognizedWrapper = (invocation: WrapperInvocationView): boolean =>
  wrapperName(invocation) !== undefined;

export const isTerminalWrapperForm = (invocation: WrapperInvocationView): boolean => {
  if (wrapperName(invocation) !== "command") return false;
  for (const argument of invocation.arguments) {
    if (argument === "-p") continue;
    return argument === "-v" || argument === "-V";
  }
  return false;
};

const target = (
  invocation: WrapperInvocationView,
  index: number,
  options: Partial<Omit<WrapperTarget, "index">> = {},
): WrapperTarget => ({
  index,
  targetKind: options.targetKind ?? "external",
  executionCwd: options.executionCwd ?? invocation.executionCwd,
  ...(options.reason ? { reason: options.reason } : {}),
  ...(options.envAssignments ? { envAssignments: options.envAssignments } : {}),
});

const commandTarget = (invocation: WrapperInvocationView): WrapperTarget | undefined => {
  for (let index = 0; index < invocation.arguments.length; index += 1) {
    const word = invocation.argumentWords[index];
    if (!word) return undefined;
    if (word.value === "-v" || word.value === "-V") return undefined;
    if (word.value === "-p") continue;
    if (word.value === "--") {
      const executable = invocation.argumentWords[index + 1];
      return target(invocation, index + 1, { targetKind: executable ? directTargetKind(executable) : "external" });
    }
    if (word.value.startsWith("-") || !word.expansionFree) return undefined;
    return target(invocation, index, { targetKind: directTargetKind(word) });
  }
  return undefined;
};

const envAssignment = (word: ShellWord): ExecutionAssignment | undefined => {
  const separator = word.value.indexOf("=");
  if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(word.value.slice(0, separator))) return undefined;
  return {
    name: word.value.slice(0, separator),
    value: word.value.slice(separator + 1),
    raw: word.raw,
    source: "env",
  };
};

const envTarget = (invocation: WrapperInvocationView): WrapperTarget | undefined => {
  const assignments: ExecutionAssignment[] = [];
  let executionCwd = invocation.executionCwd;
  for (let index = 0; index < invocation.arguments.length; index += 1) {
    const word = invocation.argumentWords[index];
    if (!word) return undefined;
    const assignment = envAssignment(word);
    if (assignment) {
      assignments.push(assignment);
      continue;
    }
    const argument = word.value;
    if (argument === "--") return target(invocation, index + 1, { envAssignments: assignments, executionCwd });
    if (argument === "-i" || argument === "--ignore-environment") continue;
    if (argument === "-C" || argument === "--chdir") {
      const directory = invocation.argumentWords[index + 1];
      if (!directory?.expansionFree) return undefined;
      executionCwd = resolve(executionCwd, directory.value);
      index += 1;
      continue;
    }
    const attachedDirectory = /^(?:-C|--chdir=)(.+)$/u.exec(argument)?.[1];
    if (attachedDirectory !== undefined) {
      if (!word.expansionFree) return undefined;
      executionCwd = resolve(executionCwd, attachedDirectory);
      continue;
    }
    if (argument === "-u" || argument === "--unset") {
      index += 1;
      if (!invocation.argumentWords[index]) return undefined;
      continue;
    }
    if (/^--unset=.+$/u.test(argument)) continue;
    if (argument.startsWith("-")) return undefined;
    return target(invocation, index, { envAssignments: assignments, executionCwd });
  }
  return undefined;
};

const execTarget = (invocation: WrapperInvocationView): WrapperTarget | undefined => {
  for (let index = 0; index < invocation.arguments.length; index += 1) {
    const argument = invocation.arguments[index] ?? "";
    if (argument === "--") return target(invocation, index + 1, { reason: "exec dispatch replaces the current shell process" });
    if (argument === "-a") {
      index += 1;
      if (!invocation.argumentWords[index]) return undefined;
      continue;
    }
    if (/^-[cl]+$/u.test(argument)) continue;
    if (argument.startsWith("-")) return undefined;
    return target(invocation, index, { reason: "exec dispatch replaces the current shell process" });
  }
  return undefined;
};

const niceTarget = (invocation: WrapperInvocationView): WrapperTarget | undefined => {
  for (let index = 0; index < invocation.arguments.length; index += 1) {
    const argument = invocation.arguments[index] ?? "";
    if (argument === "--") return target(invocation, index + 1);
    if (argument === "-n" || argument === "--adjustment") {
      const adjustment = invocation.argumentWords[index + 1];
      if (!adjustment?.expansionFree || !/^[+-]?\d+$/u.test(adjustment.value)) return undefined;
      index += 1;
      continue;
    }
    if (/^(?:-\d+|-n[+-]?\d+|--adjustment=[+-]?\d+)$/u.test(argument)) continue;
    if (argument.startsWith("-")) return undefined;
    return target(invocation, index);
  }
  return undefined;
};

const nohupTarget = (invocation: WrapperInvocationView): WrapperTarget | undefined => {
  const first = invocation.arguments[0];
  if (!first || first === "--help" || first === "--version") return undefined;
  if (first === "--") return target(invocation, 1);
  if (first.startsWith("-")) return undefined;
  return target(invocation, 0);
};

const timeTarget = (invocation: WrapperInvocationView): WrapperTarget | undefined => {
  for (let index = 0; index < invocation.arguments.length; index += 1) {
    const argument = invocation.arguments[index] ?? "";
    if (argument === "--") return target(invocation, index + 1);
    if (["-o", "--output", "-f", "--format"].includes(argument)) {
      index += 1;
      if (!invocation.argumentWords[index]) return undefined;
      continue;
    }
    if (/^(?:-o.+|--output=.+|-f.+|--format=.+|-[ahlpv]+)$/u.test(argument)) continue;
    if (argument.startsWith("-")) return undefined;
    return target(invocation, index);
  }
  return undefined;
};

const sudoTarget = (invocation: WrapperInvocationView): WrapperTarget | undefined => {
  const flags = new Set(["--askpass", "--background", "--non-interactive", "--preserve-env", "--preserve-groups", "--set-home", "--stdin"]);
  const valued = new Set(["-C", "-D", "-g", "-h", "-p", "-r", "-t", "-u", "--chdir", "--close-from", "--group", "--host", "--prompt", "--role", "--type", "--user"]);
  let executionCwd = invocation.executionCwd;
  for (let index = 0; index < invocation.arguments.length; index += 1) {
    const word = invocation.argumentWords[index];
    if (!word) return undefined;
    const argument = word.value;
    if (argument === "--") return target(invocation, index + 1, { executionCwd });
    if (valued.has(argument)) {
      const value = invocation.argumentWords[index + 1];
      if (!value?.expansionFree) return undefined;
      if (argument === "-D" || argument === "--chdir") executionCwd = resolve(executionCwd, value.value);
      index += 1;
      continue;
    }
    const attached = /^-(C|D|g|h|p|r|t|u)(.+)$/u.exec(argument);
    if (attached) {
      if (!word.expansionFree) return undefined;
      if (attached[1] === "D") executionCwd = resolve(executionCwd, attached[2] ?? "");
      continue;
    }
    const long = /^--(chdir|close-from|group|host|prompt|role|type|user)=(.+)$/u.exec(argument);
    if (long) {
      if (!word.expansionFree) return undefined;
      if (long[1] === "chdir") executionCwd = resolve(executionCwd, long[2] ?? "");
      continue;
    }
    if (/^-[AbEHnPS]+$/u.test(argument) || flags.has(argument) || /^--preserve-env=.+$/u.test(argument)) continue;
    if (argument.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(argument)) return undefined;
    return target(invocation, index, { executionCwd });
  }
  return undefined;
};

const internalTarget = (
  invocation: WrapperInvocationView,
  supported: ReadonlySet<string>,
  targetKind: "builtin" | "applet",
): WrapperTarget | undefined => {
  const executable = invocation.argumentWords[0];
  if (!executable?.expansionFree || !supported.has(executable.value)) return undefined;
  return target(invocation, 0, { reason: `${basename(invocation.commandName)} dispatch requires review`, targetKind });
};

export const wrapperTarget = (invocation: WrapperInvocationView): WrapperTarget | undefined => {
  const name = wrapperName(invocation);
  if (name === "command") return commandTarget(invocation);
  if (name === "exec") return execTarget(invocation);
  if (name === "env") return envTarget(invocation);
  if (name === "nice") return niceTarget(invocation);
  if (name === "nohup") return nohupTarget(invocation);
  if (name === "time") return timeTarget(invocation);
  if (name === "sudo") return sudoTarget(invocation);
  if (name === "builtin") return internalTarget(invocation, builtinNames, "builtin");
  if (name === "busybox") return internalTarget(invocation, busyboxApplets, "applet");
  return undefined;
};

export const wrapperOutputTargets = (wrapper: ShellWrapper): OutputTargetAnalysis => {
  const analysis = basename(wrapper.executable.value) === "time"
    ? outputOptionTargets(wrapper.arguments, timeOutputOptions)
    : { ambiguous: false, exactTargets: [] };
  return { ...analysis, exactTargets: analysis.exactTargets.map((path) =>
    path === "~" || path.startsWith("~/") ? path : resolve(wrapper.executionCwd, path)) };
};
