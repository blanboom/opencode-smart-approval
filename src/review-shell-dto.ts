import type {
  ShellAnalysis,
  ShellAssignment,
  ShellRedirection,
  ShellSegment,
  ShellWord,
  ShellWrapper,
} from "./types";

type ReviewWord = { readonly raw: string; readonly value: string; readonly expansion_free: boolean };
type ReviewAssignment = { readonly name: string; readonly value: string; readonly raw: string };
type ReviewRedirection = { readonly operator: string; readonly target: { readonly raw: string; readonly value: string } };
type ReviewWrapper = {
  readonly executable: ReviewWord;
  readonly arguments: readonly ReviewWord[];
  readonly execution_cwd: string | null;
};

export type ReviewShellAnalysis = {
  readonly source: string;
  readonly segments: readonly ReviewSegment[];
  readonly redirections: readonly ReviewRedirection[];
  readonly static_file_references: readonly {
    readonly kind: "executable" | "shell_script" | "source" | "input_redirect";
    readonly raw: string;
    readonly value: string;
    readonly top_level_segment: number;
    readonly cwd: string | null;
  }[];
  readonly issues: readonly {
    readonly kind: "syntax" | "dynamic" | "unsupported" | "identity" | "limit";
    readonly reason: string;
    readonly redirection_direction?: "input" | "output";
  }[];
  readonly nested_analyses: readonly ReviewShellAnalysis[];
};

type ReviewSegment = {
  readonly source: string;
  readonly normalized_source: string;
  readonly command_name: string;
  readonly original_executable: ReviewWord;
  readonly effective_executable: ReviewWord;
  readonly target_kind: "external" | "builtin" | "applet";
  readonly execution_cwd: string | null;
  readonly arguments: readonly string[];
  readonly raw_arguments: readonly string[];
  readonly argument_words: readonly ReviewWord[];
  readonly environment: readonly ReviewAssignment[];
  readonly assignments: readonly (ReviewAssignment & { readonly source: "shell" | "env" })[];
  readonly wrapper_chain: readonly ReviewWrapper[];
  readonly terminal_allow_eligible: boolean;
  readonly redirections: readonly ReviewRedirection[];
  readonly start_byte: number;
  readonly end_byte: number;
  readonly connector: "start" | "sequence" | "and" | "or" | "pipe";
  readonly top_level: boolean;
  readonly subshell_depth: number;
  readonly nested: boolean;
  readonly stdin_from_pipe: boolean;
};

const word = (value: ShellWord): ReviewWord => ({
  raw: value.raw,
  value: value.value,
  expansion_free: value.expansionFree,
});

const assignment = (value: ShellAssignment): ReviewAssignment => ({
  name: value.name,
  value: value.value,
  raw: value.raw,
});

const redirection = (value: ShellRedirection): ReviewRedirection => ({
  operator: value.operator,
  target: { raw: value.target.raw, value: value.target.value },
});

const wrapper = (value: ShellWrapper, cwdKnown: boolean): ReviewWrapper => ({
  executable: word(value.executable),
  arguments: value.arguments.map(word),
  execution_cwd: cwdKnown ? value.executionCwd : null,
});

const segment = (value: ShellSegment): ReviewSegment => ({
  source: value.source,
  normalized_source: value.normalizedSource,
  command_name: value.commandName,
  original_executable: word(value.originalExecutable),
  effective_executable: word(value.effectiveExecutable),
  target_kind: value.targetKind,
  execution_cwd: value.executionCwdKnown ? value.executionCwd : null,
  arguments: [...value.arguments],
  raw_arguments: [...value.rawArguments],
  argument_words: value.argumentWords.map(word),
  environment: value.environment.map(assignment),
  assignments: value.assignments.map((valueAssignment) => ({
    ...assignment(valueAssignment),
    source: valueAssignment.source,
  })),
  wrapper_chain: value.wrapperChain.map((valueWrapper) => wrapper(valueWrapper, value.executionCwdKnown)),
  terminal_allow_eligible: value.terminalAllowEligible,
  redirections: value.redirections.map(redirection),
  start_byte: value.startByte,
  end_byte: value.endByte,
  connector: value.connector,
  top_level: value.topLevel,
  subshell_depth: value.subshellDepth,
  nested: value.nested,
  stdin_from_pipe: value.stdinFromPipe,
});

const projectAnalysis = (value: ShellAnalysis, active: Set<object>): ReviewShellAnalysis => {
  if (active.has(value)) throw new TypeError("cyclic shell analysis");
  active.add(value);
  try {
    return {
      source: value.source,
      segments: value.segments.map(segment),
      redirections: value.redirections.map(redirection),
      static_file_references: value.staticFileReferences.map((reference) => ({
        kind: reference.kind,
        raw: reference.raw,
        value: reference.value,
        top_level_segment: reference.topLevelSegment,
        cwd: value.segments[reference.topLevelSegment]?.executionCwdKnown === true ? reference.cwd : null,
      })),
      issues: value.issues.map((issue) => ({
        kind: issue.kind,
        reason: issue.reason,
        ...(issue.redirectionDirection === undefined ? {} : { redirection_direction: issue.redirectionDirection }),
      })),
      nested_analyses: value.nestedAnalyses.map((nested) => projectAnalysis(nested, active)),
    };
  } finally {
    active.delete(value);
  }
};

export const projectReviewShellAnalysis = (value: ShellAnalysis): ReviewShellAnalysis =>
  projectAnalysis(value, new Set<object>());
