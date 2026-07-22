import type { OutputTargetAnalysis } from "./output-option-targets";
import type { ShellWord } from "./types";
import { acceptsArguments, parseArguments, validConfigSources, validTypeState, type ArgumentGrammar, type ParsedArguments } from "./git-config-arguments";
const fileOptions = new Set(["-f", "--file"]);
const readOperations = new Set([
  "-l",
  "--get",
  "--get-all",
  "--get-color",
  "--get-colorbool",
  "--get-regexp",
  "--get-urlmatch",
  "--list",
]);
const writeOperations = new Set([
  "-e",
  "--add",
  "--edit",
  "--remove-section",
  "--rename-section",
  "--replace-all",
  "--unset",
  "--unset-all",
]);
type Operation = "read" | "write" | "unknown";
type Grammar = ArgumentGrammar & {
  readonly operation: Exclude<Operation, "unknown">;
};

const combined = (...sets: readonly ReadonlySet<string>[]): ReadonlySet<string> =>
  new Set(sets.flatMap((values) => [...values]));
const negatable = (...values: readonly string[]): ReadonlySet<string> => new Set(values.flatMap((value) => [
  value,
  `--no-${value.slice(2)}`,
]));
const fileFlags = combined(
  negatable("--global", "--local", "--system", "--worktree"),
  new Set(["--no-blob", "--no-file"]),
);
const readFileFlags = combined(fileFlags, negatable("--includes"));
const fileValues = new Set(["-f", "--blob", "--file"]);
const displayFlags = combined(
  new Set(["-z", "--bool", "--bool-or-int", "--bool-or-str", "--expiry-date", "--int", "--no-type", "--path"]),
  negatable("--name-only", "--null", "--show-names", "--show-origin", "--show-scope"),
);
const displayWithoutName = new Set([...displayFlags].filter((option) => option !== "--name-only"));
const displayWithoutOrigin = new Set([...displayWithoutName].filter((option) => option !== "--show-origin"));
const nonTypeDisplay = new Set([...displayWithoutName].filter((option) => ![
  "--bool", "--bool-or-int", "--bool-or-str", "--expiry-date", "--int", "--no-type", "--path",
].includes(option)));
const displayValues = new Set(["-t", "--type"]);
const typeFlags = new Set(["--bool", "--bool-or-int", "--bool-or-str", "--expiry-date", "--int", "--no-type", "--path"]);
const emptyFileValues = new Set(["-f", "--blob", "--file"]);
const legacyWriterGlobals = new Set([
  "-z", "--no-comment", "--no-default", "--no-fixed-value", "--no-name-only", "--no-null",
  "--no-show-names", "--no-show-origin", "--no-show-scope", "--null", "--show-names", "--show-scope",
]);
const hasOption = (parsed: ParsedArguments, option: string): boolean => parsed.effectiveOptions.includes(option);
const fixedPattern = (operands: number) => (parsed: ParsedArguments): boolean =>
  !hasOption(parsed, "--fixed-value") || parsed.operands === operands;
const modernGetValid = (parsed: ParsedArguments): boolean => {
  const all = hasOption(parsed, "--all");
  const defaultValue = hasOption(parsed, "--default");
  const url = hasOption(parsed, "--url");
  const value = hasOption(parsed, "--value");
  return (!hasOption(parsed, "--fixed-value") || value)
    && !(defaultValue && (all || url))
    && !(url && (all || hasOption(parsed, "--regexp") || value));
};
const fileGrammar = {
  dashValues: fileValues,
  emptyValues: emptyFileValues,
  flags: fileFlags,
  valued: fileValues,
} as const;
const modernGrammar = new Map<string, Grammar>([
  ["get", {
    dashValues: combined(fileValues, new Set(["--default", "--url", "--value"])),
    emptyValues: combined(emptyFileValues, new Set(["--default", "--url", "--value"])),
    maxOperands: 1,
    minOperands: 1,
    operation: "read",
    flags: combined(
      readFileFlags,
      displayFlags,
      negatable("--all", "--fixed-value", "--regexp"),
      new Set(["--no-default", "--no-url", "--no-value"]),
    ),
    valued: combined(fileValues, displayValues, new Set(["--default", "--url", "--value"])),
    validate: modernGetValid,
  }],
  ["list", { ...fileGrammar, operation: "read", flags: combined(readFileFlags, displayFlags), maxOperands: 0, minOperands: 0, valued: combined(fileValues, displayValues) }],
  ["set", {
    dashValues: combined(fileValues, new Set(["--comment", "--value"])),
    emptyValues: combined(emptyFileValues, new Set(["--comment", "--value"])),
    maxOperands: 2,
    minOperands: 2,
    operation: "write",
    flags: combined(fileFlags, typeFlags, negatable("--all", "--append", "--fixed-value"), new Set(["--no-comment", "--no-value"])),
    valued: combined(fileValues, displayValues, new Set(["--comment", "--value"])),
    validate: (parsed) => (!hasOption(parsed, "--fixed-value") || hasOption(parsed, "--value"))
      && !(hasOption(parsed, "--append") && hasOption(parsed, "--value")),
  }],
  ["unset", {
    dashValues: combined(fileValues, new Set(["--value"])),
    emptyValues: combined(emptyFileValues, new Set(["--value"])),
    maxOperands: 1,
    minOperands: 1,
    operation: "write",
    flags: combined(fileFlags, negatable("--all", "--fixed-value"), new Set(["--no-value"])),
    valued: combined(fileValues, new Set(["--value"])),
    validate: (parsed) => !hasOption(parsed, "--fixed-value") || hasOption(parsed, "--value"),
  }],
  ["rename-section", { operation: "write", ...fileGrammar, maxOperands: 2, minOperands: 2 }],
  ["remove-section", { operation: "write", ...fileGrammar, maxOperands: 1, minOperands: 1 }],
  ["edit", { operation: "write", ...fileGrammar, maxOperands: 0, minOperands: 0 }],
]);

const legacyRead: Grammar = {
  dashValues: combined(fileValues, new Set(["--default"])),
  emptyValues: combined(emptyFileValues, new Set(["--default"])),
  operation: "read",
  flags: combined(readFileFlags, displayWithoutName, negatable("--fixed-value"), new Set(["--no-default"])),
  maxOperands: 2,
  minOperands: 1,
  valued: combined(fileValues, displayValues, new Set(["--default"])),
  validate: fixedPattern(2),
};
const legacyWrite: Grammar = {
  dashValues: combined(fileValues, new Set(["--comment"])),
  emptyValues: combined(emptyFileValues, new Set(["--comment"])),
  operation: "write",
  flags: combined(readFileFlags, typeFlags, legacyWriterGlobals, new Set(["--fixed-value"])),
  maxOperands: 3,
  minOperands: 2,
  valued: combined(fileValues, displayValues, new Set(["--comment"])),
  validate: fixedPattern(3),
};
const legacyUnion: Grammar = {
  dashValues: combined(legacyRead.dashValues ?? new Set(), legacyWrite.dashValues ?? new Set()),
  emptyValues: combined(legacyRead.emptyValues ?? new Set(), legacyWrite.emptyValues ?? new Set()),
  operation: "read",
  flags: combined(legacyRead.flags, legacyWrite.flags, displayFlags, readOperations, writeOperations),
  maxOperands: Number.POSITIVE_INFINITY,
  minOperands: 0,
  valued: combined(legacyRead.valued, legacyWrite.valued),
};
const withArity = (grammar: Grammar, minOperands: number, maxOperands: number): Grammar => ({
  ...grammar,
  maxOperands,
  minOperands,
});
const legacyDisplayRead: Grammar = {
  ...legacyRead,
  emptyValues: emptyFileValues,
  flags: combined(readFileFlags, displayWithoutName, negatable("--fixed-value")),
  valued: combined(fileValues, displayValues),
};
const legacyUrlRead: Grammar = {
  ...legacyRead,
  emptyValues: emptyFileValues,
  flags: combined(readFileFlags, displayWithoutOrigin),
  valued: combined(fileValues, displayValues),
  validate: () => true,
};
const legacyColorRead: Grammar = {
  ...legacyUrlRead,
  flags: combined(readFileFlags, new Set([...nonTypeDisplay].filter((option) => option !== "--show-origin")), new Set(["--no-type"])),
  valued: fileValues,
};
const legacyLocationWrite: Grammar = {
  ...legacyWrite,
  emptyValues: emptyFileValues,
  flags: combined(readFileFlags, typeFlags, legacyWriterGlobals),
  valued: combined(fileValues, displayValues),
  validate: () => true,
};
const legacyMutationWrite: Grammar = {
  ...legacyLocationWrite,
  flags: combined(legacyLocationWrite.flags, negatable("--fixed-value")),
};
const legacyActions = new Map<string, Grammar>([
  ["-l", { ...withArity(legacyDisplayRead, 0, 0), flags: combined(legacyDisplayRead.flags, new Set(["--name-only"])), validate: (parsed) => !hasOption(parsed, "--fixed-value") }],
  ["--list", { ...withArity(legacyDisplayRead, 0, 0), flags: combined(legacyDisplayRead.flags, new Set(["--name-only"])), validate: (parsed) => !hasOption(parsed, "--fixed-value") }],
  ["--get", withArity(legacyRead, 1, 2)],
  ["--get-all", { ...withArity(legacyDisplayRead, 1, 2), validate: fixedPattern(2) }],
  ["--get-regexp", { ...withArity(legacyDisplayRead, 1, 2), flags: combined(legacyDisplayRead.flags, new Set(["--name-only"])), validate: fixedPattern(2) }],
  ["--get-urlmatch", withArity(legacyUrlRead, 2, 2)],
  ["--get-color", withArity(legacyColorRead, 1, 2)],
  ["--get-colorbool", withArity(legacyColorRead, 1, 2)],
  ["--add", { ...withArity(legacyWrite, 2, 2), validate: (parsed) => !hasOption(parsed, "--fixed-value") }],
  ["--replace-all", { ...withArity(legacyWrite, 2, 3), validate: fixedPattern(3) }],
  ["--unset", { ...withArity(legacyMutationWrite, 1, 2), validate: fixedPattern(2) }],
  ["--unset-all", { ...withArity(legacyMutationWrite, 1, 2), validate: fixedPattern(2) }],
  ["--rename-section", withArity(legacyLocationWrite, 2, 2)],
  ["--remove-section", withArity(legacyLocationWrite, 1, 1)],
  ["-e", withArity(legacyLocationWrite, 0, 0)],
  ["--edit", withArity(legacyLocationWrite, 0, 0)],
]);

const modernAnalysis = (words: readonly ShellWord[]): { operation: Operation; parsed: ParsedArguments } | undefined => {
  const first = words[0];
  if (!first?.expansionFree || first.value.startsWith("-")) return undefined;
  const grammar = modernGrammar.get(first.value);
  if (!grammar) return first.value.includes(".") ? undefined : {
    operation: "unknown",
    parsed: parseArguments(words.slice(1), legacyUnion, fileOptions),
  };
  const parsed = parseArguments(words.slice(1), grammar, fileOptions);
  const accepted = acceptsArguments(parsed, grammar, new Set()) && validConfigSources(parsed) && validTypeState(parsed);
  return { operation: accepted ? grammar.operation : "unknown", parsed };
};

const legacyAnalysis = (words: readonly ShellWord[]): { operation: Operation; parsed: ParsedArguments } => {
  const first = words[0];
  const parsed = parseArguments(words, legacyUnion, fileOptions);
  if (first && !first.expansionFree && !first.value.startsWith("-")) return { operation: "unknown", parsed };
  const canonicalAction = (option: string): string => option === "-e" ? "--edit" : option === "-l" ? "--list" : option;
  const actions = new Set(parsed.options
    .filter((option) => readOperations.has(option) || writeOperations.has(option))
    .map(canonicalAction));
  if (actions.size > 1) return { operation: "unknown", parsed };
  const action = [...actions][0];
  const grammar = action
    ? legacyActions.get(action)
    : parsed.operands >= 2 ? legacyWrite : legacyRead;
  if (!grammar) return { operation: "unknown", parsed };
  const operationOptions = action === "--edit"
    ? new Set(["-e", "--edit"])
    : action === "--list" ? new Set(["-l", "--list"]) : action ? new Set([action]) : new Set<string>();
  return {
    operation: acceptsArguments(parsed, grammar, operationOptions)
      && validConfigSources(parsed)
      && validTypeState(parsed) ? grammar.operation : "unknown",
    parsed,
  };
};

export const gitConfigTargets = (words: readonly ShellWord[]): OutputTargetAnalysis => {
  const analysis = modernAnalysis(words) ?? legacyAnalysis(words);
  if (analysis.operation === "write") return {
    ambiguous: analysis.parsed.ambiguousTarget,
    exactTargets: analysis.parsed.exactTargets,
  };
  if (analysis.operation === "read") return { ambiguous: false, exactTargets: [] };
  return { ambiguous: true, exactTargets: [] };
};
