import type { ShellWord } from "./types";

export type ArgumentGrammar = {
  readonly dashValues?: ReadonlySet<string>;
  readonly emptyValues?: ReadonlySet<string>;
  readonly flags: ReadonlySet<string>;
  readonly maxOperands: number;
  readonly minOperands: number;
  readonly valued: ReadonlySet<string>;
  readonly validate?: (parsed: ParsedArguments) => boolean;
};

export type ParsedArguments = {
  readonly ambiguousTarget: boolean;
  readonly effectiveOptions: readonly string[];
  readonly exactTargets: readonly string[];
  readonly operands: number;
  readonly options: readonly string[];
  readonly optionValues: readonly (string | undefined)[];
  readonly valid: boolean;
};

const lastIndexOfAny = (options: readonly string[], names: ReadonlySet<string>): number => {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    const option = options[index];
    if (option !== undefined && names.has(option)) return index;
  }
  return -1;
};
const semanticLastWins = [
  new Set(["-t", "--type", "--bool", "--bool-or-int", "--bool-or-str", "--expiry-date", "--int", "--no-type", "--path"]),
  new Set(["-z", "--null", "--no-null"]),
];

export const parseArguments = (
  words: readonly ShellWord[],
  grammar: ArgumentGrammar,
  targetOptions: ReadonlySet<string>,
): ParsedArguments => {
  const options: string[] = [];
  const optionValues: (string | undefined)[] = [];
  let ambiguousTarget = false;
  let exactTarget: string | undefined;
  let operands = 0;
  let optionsEnded = false;
  let valid = true;
  const recordOption = (name: string, value?: string): void => {
    options.push(name);
    optionValues.push(value);
    if (name === "--no-file") {
      ambiguousTarget = false;
      exactTarget = undefined;
    }
  };
  const recordValue = (name: string, word: ShellWord, value = word.value): void => {
    recordOption(name, value);
    if (targetOptions.has(name)) {
      exactTarget = value.length > 0 ? value : undefined;
      ambiguousTarget = value.length === 0 || !word.expansionFree;
    } else if (!word.expansionFree) valid = false;
  };
  const consumeNext = (name: string, index: number): number => {
    const next = words[index + 1];
    const emptyAllowed = grammar.emptyValues?.has(name) === true;
    const dashAllowed = grammar.dashValues?.has(name) === true;
    if (!next || (next.value.length === 0 && !emptyAllowed) || (next.value.startsWith("-") && !dashAllowed)) {
      valid = false;
      return index;
    }
    recordValue(name, next);
    return index + 1;
  };
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (!word) continue;
    const value = word.value;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded || !value.startsWith("-") || value === "-") {
      operands += 1;
      continue;
    }
    if (!word.expansionFree) {
      valid = false;
      continue;
    }
    if (value.startsWith("--")) {
      const separator = value.indexOf("=");
      const spelling = separator < 0 ? value : value.slice(0, separator);
      const names = new Set([...grammar.flags, ...grammar.valued].filter((name) => name.startsWith("--")));
      const matches = names.has(spelling) ? [spelling] : [...names].filter((name) => name.startsWith(spelling));
      const name = matches.length === 1 ? matches[0] : undefined;
      if (!name) {
        valid = false;
        continue;
      }
      if (grammar.flags.has(name)) {
        if (separator >= 0) valid = false;
        else recordOption(name);
      } else if (separator < 0) index = consumeNext(name, index);
      else {
        const attached = value.slice(separator + 1);
        if (attached.length === 0 && grammar.emptyValues?.has(name) !== true) valid = false;
        else recordValue(name, word, attached);
      }
      continue;
    }
    for (let offset = 1; offset < value.length; offset += 1) {
      const name = `-${value[offset]}`;
      if (grammar.flags.has(name)) {
        recordOption(name);
        continue;
      }
      if (!grammar.valued.has(name)) {
        valid = false;
        break;
      }
      const attached = value.slice(offset + 1);
      if (attached.length > 0) recordValue(name, word, attached);
      else index = consumeNext(name, index);
      break;
    }
  }
  const effectiveOptions = options.filter((option, index) => {
    const group = semanticLastWins.find((candidate) => candidate.has(option));
    if (group && index !== lastIndexOfAny(options, group)) return false;
    if (!option.startsWith("--")) return true;
    const positive = option.startsWith("--no-") ? `--${option.slice(5)}` : option;
    return index === lastIndexOfAny(options, new Set([positive, `--no-${positive.slice(2)}`]));
  });
  return {
    ambiguousTarget,
    effectiveOptions,
    exactTargets: exactTarget === undefined ? [] : [exactTarget],
    operands,
    options,
    optionValues,
    valid,
  };
};

const sourceEnabled = (
  parsed: ParsedArguments,
  positive: ReadonlySet<string>,
  negative: ReadonlySet<string>,
): boolean => lastIndexOfAny(parsed.options, positive) > lastIndexOfAny(parsed.options, negative);

export const validConfigSources = (parsed: ParsedArguments): boolean => [
  sourceEnabled(parsed, new Set(["-f", "--file"]), new Set(["--no-file"])),
  sourceEnabled(parsed, new Set(["--blob"]), new Set(["--no-blob"])),
  sourceEnabled(parsed, new Set(["--global"]), new Set(["--no-global"])),
  sourceEnabled(parsed, new Set(["--local"]), new Set(["--no-local"])),
  sourceEnabled(parsed, new Set(["--system"]), new Set(["--no-system"])),
  sourceEnabled(parsed, new Set(["--worktree"]), new Set(["--no-worktree"])),
].filter(Boolean).length <= 1;

const typeFlags = new Map([
  ["--bool", "bool"], ["--bool-or-int", "bool-or-int"], ["--bool-or-str", "bool-or-str"],
  ["--expiry-date", "expiry-date"], ["--int", "int"], ["--path", "path"],
]);
const typeValues = new Set(["bool", "bool-or-int", "bool-or-str", "color", "expiry-date", "int", "path"]);

export const validTypeState = (parsed: ParsedArguments): boolean => {
  let current: string | undefined;
  for (let index = 0; index < parsed.options.length; index += 1) {
    const option = parsed.options[index];
    if (option === "--no-type") {
      current = undefined;
      continue;
    }
    const value = option === "-t" || option === "--type"
      ? parsed.optionValues[index]
      : option === undefined ? undefined : typeFlags.get(option);
    if (value === undefined) continue;
    if (!typeValues.has(value) || (current !== undefined && current !== value)) return false;
    current = value;
  }
  return true;
};

export const acceptsArguments = (
  parsed: ParsedArguments,
  grammar: ArgumentGrammar,
  operationOptions: ReadonlySet<string>,
): boolean => parsed.valid
  && parsed.operands >= grammar.minOperands
  && parsed.operands <= grammar.maxOperands
  && parsed.effectiveOptions.every((option) =>
    grammar.flags.has(option) || grammar.valued.has(option) || operationOptions.has(option)
  )
  && (grammar.validate?.(parsed) ?? true);
