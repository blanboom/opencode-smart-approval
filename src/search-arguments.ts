import {
  commandArguments,
  commandBasename,
  type CommandArgument,
  type CommandInvocation,
} from "./command-invocation";
import { parseShortOptionToken, rawAttachedValue, type ShortOptionRole } from "./short-options";

type SearchAnalysis = {
  readonly paths: readonly CommandArgument[];
  readonly selectors: readonly CommandArgument[];
  readonly recursive: boolean;
  readonly hidden: boolean;
};

const ignoredLongValues = {
  grep: new Set([
    "--after-context", "--before-context", "--binary-files", "--context", "--devices",
    "--exclude", "--exclude-dir", "--label", "--max-count",
  ]),
  rg: new Set([
    "--after-context", "--before-context", "--binary-files", "--color", "--colors", "--context",
    "--context-separator", "--dfa-size-limit", "--encoding", "--engine", "--field-context-separator",
    "--field-match-separator", "--hostname-bin", "--hyperlink-format", "--max-columns", "--max-count",
    "--max-depth", "--max-filesize", "--path-separator", "--pre", "--regex-size-limit", "--replace",
    "--sort", "--sortr", "--threads", "--type", "--type-add", "--type-not",
  ]),
} as const;

const shortRoles: Readonly<Record<"grep" | "rg", Readonly<Record<string, ShortOptionRole>>>> = {
  grep: { A: "value", B: "value", C: "value", D: "value", d: "value", e: "value", f: "path", m: "value" },
  rg: {
    A: "value", B: "value", C: "value", E: "value", e: "value", f: "path", g: "value", j: "value",
    M: "value", m: "value", r: "value", t: "value", T: "value",
  },
};

const attached = (argument: CommandArgument, prefix: RegExp): CommandArgument | undefined => {
  const value = argument.value.match(prefix)?.[1];
  return value ? { raw: rawAttachedValue(argument, value), value } : undefined;
};

const analyzeSearch = (invocation: CommandInvocation): SearchAnalysis => {
  const name = commandBasename(invocation) === "rg" ? "rg" : "grep";
  const pairs = commandArguments(invocation);
  const paths: CommandArgument[] = [];
  const selectors: CommandArgument[] = [];
  let expecting: "directory_mode" | "ignore" | "path" | "pattern" | "pattern_path" | "selector" | undefined;
  let options = true;
  let patternSupplied = false;
  let pathOnly = false;
  let recursive = name === "rg";
  let hidden = false;
  let unrestrict = 0;
  for (let index = 0; index < pairs.length; index += 1) {
    const argument = pairs[index];
    if (!argument) continue;
    if (expecting) {
      if (expecting === "directory_mode" && argument.value === "recurse") recursive = true;
      if (expecting === "path" || expecting === "pattern_path") paths.push(argument);
      if (expecting === "selector") selectors.push(argument);
      if (expecting === "pattern" || expecting === "pattern_path") patternSupplied = true;
      expecting = undefined;
      continue;
    }
    if (options && argument.value === "--") {
      options = false;
      continue;
    }
    if (options && name === "rg" && argument.value === "--files") {
      pathOnly = true;
      patternSupplied = true;
      continue;
    }
    if (options && ["--regexp"].includes(argument.value)) {
      expecting = "pattern";
      continue;
    }
    if (options && argument.value === "--file") {
      expecting = "pattern_path";
      continue;
    }
    if (options && ["--ignore-file", "--exclude-from"].includes(argument.value)) {
      expecting = "path";
      continue;
    }
    if (options && name === "grep" && argument.value === "--directories") {
      expecting = "directory_mode";
      continue;
    }
    if (options && name === "grep" && argument.value === "--directories=recurse") {
      recursive = true;
      continue;
    }
    if (options && ["--glob", "--iglob", "--pre-glob", "--include"].includes(argument.value)) {
      expecting = "selector";
      continue;
    }
    const pattern = options ? attached(argument, /^--regexp=(.+)$/u) : undefined;
    if (pattern) {
      patternSupplied = true;
      continue;
    }
    const patternPath = options ? attached(argument, /^--file=(.+)$/u) : undefined;
    if (patternPath) {
      paths.push(patternPath);
      patternSupplied = true;
      continue;
    }
    const auxiliary = options ? attached(argument, /^--(?:ignore-file|exclude-from)=(.+)$/u) : undefined;
    if (auxiliary) {
      paths.push(auxiliary);
      continue;
    }
    const selector = options ? attached(argument, /^--(?:glob|iglob|pre-glob|include)=(.+)$/u) : undefined;
    if (selector) {
      selectors.push(selector);
      continue;
    }
    if (options && /^-[^-]/u.test(argument.value)) {
      const parsed = parseShortOptionToken(argument, pairs[index + 1], shortRoles[name]);
      for (const option of parsed) {
        if (option.name === "e") patternSupplied = true;
        if (option.name === "f" && option.value) {
          paths.push(option.value);
          patternSupplied = true;
        }
        if (name === "rg" && option.name === "g" && option.value) selectors.push(option.value);
        if (name === "grep" && ["r", "R"].includes(option.name)) recursive = true;
        if (name === "grep" && option.name === "d" && option.value?.value === "recurse") recursive = true;
        if (name === "rg" && option.name === "u") unrestrict += 1;
        if (name === "rg" && option.name === ".") hidden = true;
      }
      if (parsed.some((option) => option.consumesNext)) index += 1;
      continue;
    }
    if (options && ignoredLongValues[name].has(argument.value)) {
      expecting = "ignore";
      continue;
    }
    if (options && name === "grep" && ["--recursive", "--dereference-recursive"].includes(argument.value)) recursive = true;
    if (options && name === "rg" && argument.value === "--hidden") hidden = true;
    if (options && name === "rg" && argument.value === "--unrestricted") unrestrict += 1;
    if (options && argument.value.startsWith("-")) continue;
    if (pathOnly || patternSupplied) paths.push(argument);
    else patternSupplied = true;
  }
  return { paths, selectors, recursive, hidden: hidden || unrestrict >= 2 };
};

export const searchPathArguments = (invocation: CommandInvocation): readonly CommandArgument[] =>
  analyzeSearch(invocation).paths;

export const searchSelectors = (invocation: CommandInvocation): readonly CommandArgument[] =>
  analyzeSearch(invocation).selectors;

export const searchTraversalPolicy = (invocation: CommandInvocation): {
  readonly recursive: boolean;
  readonly hidden: boolean;
} => {
  const analysis = analyzeSearch(invocation);
  return { recursive: analysis.recursive, hidden: commandBasename(invocation) === "rg" ? analysis.hidden : analysis.recursive };
};
