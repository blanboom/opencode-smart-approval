import { basename } from "node:path";
import { directTargetKind, isRecognizedWrapper, isTerminalWrapperForm, wrapperTarget, type WrapperTarget } from "./command-wrapper-targets";
import type { ExecutionAssignment, ExecutionTargetKind, ShellAssignment, ShellSegment, ShellWord, ShellWrapper } from "./types";

export type CommandArgument = {
  readonly raw: string;
  readonly value: string;
  readonly resolutionBase?: string;
};

export type CommandInvocation = {
  readonly commandName: string;
  readonly arguments: readonly string[];
  readonly rawArguments: readonly string[];
  readonly argumentWords: readonly ShellWord[];
  readonly originalExecutable: ShellWord;
  readonly originalArguments: readonly ShellWord[];
  readonly effectiveExecutable: ShellWord;
  readonly targetKind: ExecutionTargetKind;
  readonly executionCwd: string;
  readonly executionCwdKnown: boolean;
  readonly assignments: readonly ExecutionAssignment[];
  readonly wrapperChain: readonly ShellWrapper[];
  readonly terminalAllowEligible: boolean;
  readonly argumentOffset: number;
  readonly reviewReasons: readonly string[];
};

type InvocationSeed = {
  readonly executable: ShellWord;
  readonly arguments: readonly ShellWord[];
  readonly assignments: readonly ShellAssignment[];
  readonly cwd?: string;
  readonly cwdKnown?: boolean;
};

export const commandBasename = (invocation: Pick<CommandInvocation, "commandName">): string =>
  basename(invocation.commandName);

const withTerminalEligibility = (invocation: CommandInvocation): CommandInvocation => ({
  ...invocation,
  terminalAllowEligible: invocation.wrapperChain.length === 0
    && invocation.assignments.length === 0
    && invocation.reviewReasons.length === 0
    && invocation.originalExecutable.expansionFree
    && invocation.effectiveExecutable.expansionFree
    && invocation.originalExecutable.value === invocation.effectiveExecutable.value,
});

export const commandInvocation = ({ executable, arguments: words, assignments, cwd = process.cwd(), cwdKnown = true }: InvocationSeed): CommandInvocation =>
  withTerminalEligibility({
    commandName: executable.value,
    arguments: words.map((word) => word.value),
    rawArguments: words.map((word) => word.raw),
    argumentWords: words,
    originalExecutable: executable,
    originalArguments: words,
    effectiveExecutable: executable,
    targetKind: directTargetKind(executable),
    executionCwd: cwd,
    executionCwdKnown: cwdKnown,
    assignments: assignments.map((assignment) => ({ ...assignment, source: "shell" })),
    wrapperChain: [],
    terminalAllowEligible: false,
    argumentOffset: 0,
    reviewReasons: [],
  });

export const invocationFromSegment = (segment: ShellSegment): CommandInvocation => commandInvocation({
  executable: segment.originalExecutable,
  arguments: segment.argumentWords,
  assignments: segment.environment,
  cwd: segment.wrapperChain[0]?.executionCwd ?? segment.executionCwd,
  cwdKnown: segment.executionCwdKnown,
});

export const commandArguments = (invocation: CommandInvocation): readonly CommandArgument[] =>
  invocation.argumentWords.map((word) => ({ raw: word.raw, value: word.value }));

const advance = (invocation: CommandInvocation, options: WrapperTarget): CommandInvocation | undefined => {
  const executable = invocation.argumentWords[options.index];
  if (!executable) return undefined;
  const words = invocation.argumentWords.slice(options.index + 1);
  return withTerminalEligibility({
    ...invocation,
    commandName: executable.value,
    arguments: words.map((word) => word.value),
    rawArguments: words.map((word) => word.raw),
    argumentWords: words,
    effectiveExecutable: executable,
    targetKind: options.targetKind,
    executionCwd: options.executionCwd,
    assignments: [...invocation.assignments, ...(options.envAssignments ?? [])],
    wrapperChain: [
      ...invocation.wrapperChain,
      {
        executable: invocation.effectiveExecutable,
        arguments: invocation.argumentWords.slice(0, options.index),
        executionCwd: invocation.executionCwd,
      },
    ],
    argumentOffset: invocation.argumentOffset + options.index + 1,
    reviewReasons: options.reason ? [...invocation.reviewReasons, options.reason] : invocation.reviewReasons,
  });
};

export const effectiveInvocation = (initial: CommandInvocation): CommandInvocation => {
  let invocation = initial;
  while (true) {
    const target = wrapperTarget(invocation);
    if (!target) {
      if (isTerminalWrapperForm(invocation)) return withTerminalEligibility(invocation);
      if (!isRecognizedWrapper(invocation)) return withTerminalEligibility(invocation);
      return withTerminalEligibility({
        ...invocation,
        reviewReasons: [...invocation.reviewReasons, `${commandBasename(invocation)} wrapper options require review`],
      });
    }
    const advanced = advance(invocation, target);
    if (!advanced) {
      return withTerminalEligibility({
        ...invocation,
        reviewReasons: [...invocation.reviewReasons, `${commandBasename(invocation)} wrapper target requires review`],
      });
    }
    invocation = advanced;
  }
};
