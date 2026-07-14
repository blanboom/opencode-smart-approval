import {
  commandArguments,
  commandBasename,
  type CommandArgument,
  type CommandInvocation,
} from "./command-invocation";
import { parseGitInvocation } from "./git-invocation";
import { isAbsolute, join, normalize } from "node:path";
import { searchPathArguments } from "./search-arguments";
import { sedPathArguments } from "./sed-safety";
import { parseShortOptionToken, rawAttachedValue, type ShortOptionRole } from "./short-options";
import { jqPathArguments, jqPrograms } from "./jq-reader-arguments";

export { jqPrograms } from "./jq-reader-arguments";

const readers = new Set([
  "base64", "cat", "cksum", "comm", "cut", "egrep", "fgrep", "file", "fmt", "fold", "ffprobe",
  "git", "grep", "head", "join", "jq", "md5", "nl", "paste", "rg", "sed", "shasum", "sort", "strings", "tail", "wc",
]);

export const isReaderCommand = (invocation: CommandInvocation): boolean =>
  readers.has(commandBasename(invocation));

const ignoredValues: Readonly<Record<string, ReadonlySet<string>>> = {
  base64: new Set(["-b"]),
  cksum: new Set(["-a", "--algorithm"]),
  comm: new Set(["--output-delimiter"]),
  commit: new Set([
    "-c", "-C", "-m", "--author", "--cleanup", "--date", "--fixup", "--message",
    "--reedit-message", "--reuse-message", "--squash", "--trailer",
  ]),
  diff: new Set([
    "--anchored", "--diff-algorithm", "--dst-prefix", "--inter-hunk-context", "--line-prefix",
    "--output-indicator-context", "--output-indicator-new", "--output-indicator-old", "--src-prefix",
    "--word-diff-regex",
  ]),
  cut: new Set(["-b", "-c", "-d", "-f", "--bytes", "--characters", "--delimiter", "--fields", "--output-delimiter"]),
  file: new Set(["-e", "-F", "-P", "--exclude", "--exclude-quiet", "--parameter", "--separator"]),
  fmt: new Set(["-g", "-p", "-w", "--goal", "--prefix", "--width"]),
  fold: new Set(["-w", "--width"]),
  head: new Set(["-c", "-n", "--bytes", "--lines"]),
  log: new Set([
    "--after", "--author", "--before", "--committer", "--date", "--encoding", "--format", "--grep",
    "--max-count", "--pretty", "--since", "--until",
  ]),
  join: new Set(["-a", "-e", "-j", "-o", "-t", "-v"]),
  md5: new Set(["-c", "-s"]),
  nl: new Set(["-b", "-d", "-f", "-h", "-i", "-l", "-n", "-s", "-v", "-w"]),
  paste: new Set(["-d", "--delimiters"]),
  shasum: new Set(["-a", "--algorithm"]),
  sort: new Set(["-k", "-t", "--batch-size", "--field-separator", "--key", "--parallel"]),
  strings: new Set(["-n", "-t", "--bytes", "--radix"]),
  tail: new Set(["-c", "-n", "-s", "--bytes", "--lines", "--pid", "--sleep-interval"]),
  show: new Set(["--date", "--encoding", "--format", "--pretty"]),
  shortlog: new Set(["--format", "--group"]),
  "for-each-ref": new Set(["--contains", "--count", "--format", "--merged", "--no-contains", "--no-merged", "--points-at", "--sort"]),
  whatchanged: new Set(["--after", "--before", "--date", "--format", "--pretty", "--since", "--until"]),
};

const inputOptions: Readonly<Record<string, readonly [readonly string[], readonly string[]]>> = {
  base64: [["-i"], ["--input"]],
  commit: [["-F", "-t"], ["--file", "--pathspec-from-file", "--template"]],
  blame: [[], ["--contents"]],
  diff: [["-O"], []],
  file: [["-f", "-m", "-M"], ["--files-from", "--magic-file"]],
  sort: [[], ["--files0-from", "--random-source"]],
  wc: [[], ["--files0-from"]],
};

const clusteredRoles: Readonly<Record<string, Readonly<Record<string, ShortOptionRole>>>> = {
  base64: { b: "value", i: "path", o: "path" },
  commit: { c: "value", C: "value", F: "path", m: "value", t: "path" },
  file: { e: "value", f: "path", F: "value", m: "path", M: "path", P: "value" },
  sort: { k: "value", o: "path", t: "value", T: "path" },
};

const genericPaths = (invocation: CommandInvocation): readonly CommandArgument[] => {
  const paths: CommandArgument[] = [];
  const pairs = commandArguments(invocation);
  const name = commandBasename(invocation);
  const [shortInputs, longInputs] = inputOptions[name] ?? [[], []];
  const valueOptions = ignoredValues[name] ?? new Set<string>();
  const shortRoles = clusteredRoles[name];
  let options = true;
  for (let index = 0; index < pairs.length; index += 1) {
    const argument = pairs[index];
    if (!argument || argument.value === "-") continue;
    if (options && argument.value === "--") {
      options = false;
      continue;
    }
    if (options && shortRoles && /^-[^-]/u.test(argument.value)) {
      const parsed = parseShortOptionToken(argument, pairs[index + 1], shortRoles);
      for (const option of parsed) {
        if (option.role === "path" && option.value) paths.push(option.value);
      }
      if (parsed.some((option) => option.consumesNext)) index += 1;
      continue;
    }
    const longPath = options
      ? longInputs.flatMap((option) => argument.value.startsWith(`${option}=`) ? [argument.value.slice(option.length + 1)] : [])[0]
      : undefined;
    const shortPath = options
      ? shortInputs.flatMap((option) => argument.value.startsWith(option) && argument.value.length > option.length
        ? [argument.value.slice(option.length).replace(/^=/u, "")]
        : [])[0]
      : undefined;
    const attachedPath = longPath ?? shortPath;
    if (attachedPath) {
      paths.push({ raw: rawAttachedValue(argument, attachedPath), value: attachedPath });
      continue;
    }
    if (options && [...shortInputs, ...longInputs].includes(argument.value)) {
      const path = pairs[index + 1];
      if (path) paths.push(path);
      index += 1;
      continue;
    }
    if (options && valueOptions.has(argument.value)) {
      index += 1;
      continue;
    }
    if (options && argument.value.startsWith("-")) continue;
    paths.push(argument);
  }
  return paths;
};

const gitPathGroups = (invocation: CommandInvocation): {
  readonly global: readonly CommandArgument[];
  readonly subcommand: readonly CommandArgument[];
} => {
  const parsed = parseGitInvocation(invocation);
  const paths: CommandArgument[] = [];
  const globals = commandArguments(invocation).slice(0, Math.max(0, parsed.argumentOffset - 1));
  let gitBase = ".";
  const fromGitBase = (argument: CommandArgument): CommandArgument => ({ ...argument, resolutionBase: gitBase });
  const advanceGitBase = (value: string): void => {
    gitBase = isAbsolute(value) ? normalize(value) : normalize(join(gitBase, value));
  };
  for (let index = 0; index < globals.length; index += 1) {
    const argument = globals[index];
    if (!argument) continue;
    if (argument.value === "-C") {
      const path = globals[index + 1];
      if (path) {
        paths.push(fromGitBase(path));
        advanceGitBase(path.value);
      }
      index += 1;
      continue;
    }
    const attachedDirectory = argument.value.match(/^-C(.+)$/u)?.[1];
    if (attachedDirectory) {
      const path = { raw: rawAttachedValue(argument, attachedDirectory), value: attachedDirectory };
      paths.push(fromGitBase(path));
      advanceGitBase(attachedDirectory);
      continue;
    }
    if (["--git-dir", "--work-tree"].includes(argument.value)) {
      const path = globals[index + 1];
      if (path) paths.push(fromGitBase(path));
      index += 1;
      continue;
    }
    const attached = argument.value.match(/^--(?:git-dir|work-tree)=(.+)$/u)?.[1];
    if (attached) paths.push(fromGitBase({ raw: rawAttachedValue(argument, attached), value: attached }));
  }
  const subInvocation: CommandInvocation = {
    commandName: parsed.subcommand ?? "git",
    arguments: parsed.arguments,
    rawArguments: invocation.rawArguments.slice(parsed.argumentOffset),
    argumentOffset: 0,
    reviewReasons: [],
  };
  const lineRangePath = parsed.arguments.flatMap((argument, index) => {
    if (parsed.subcommand !== "log") return [];
    const value = argument === "-L" ? parsed.arguments[index + 1] : argument.startsWith("-L") ? argument.slice(2) : undefined;
    const path = value?.match(/:(.+)$/u)?.[1];
    return path ? [{ raw: path, value: path }] : [];
  });
  return {
    global: paths,
    subcommand: [
    ...lineRangePath.map(fromGitBase),
    ...(parsed.subcommand === "grep" ? searchPathArguments({ ...subInvocation, commandName: "grep" }) : genericPaths(subInvocation)).map(fromGitBase),
    ],
  };
};

const gitPaths = (invocation: CommandInvocation): readonly CommandArgument[] => {
  const paths = gitPathGroups(invocation);
  return [...paths.global, ...paths.subcommand];
};

export const pathArgumentGroupsFor = (invocation: CommandInvocation): {
  readonly all: readonly CommandArgument[];
  readonly sensitive: readonly CommandArgument[];
} => {
  const name = commandBasename(invocation);
  if (name === "git") {
    const paths = gitPathGroups(invocation);
    return { all: [...paths.global, ...paths.subcommand], sensitive: paths.subcommand };
  }
  const paths = ["egrep", "fgrep", "grep", "rg"].includes(name)
    ? searchPathArguments(invocation)
      : name === "jq"
      ? jqPathArguments(invocation)
      : name === "sed"
        ? sedPathArguments(invocation)
        : name === "tr"
          ? []
          : genericPaths(invocation);
  return { all: paths, sensitive: paths };
};

export const pathArgumentsFor = (invocation: CommandInvocation): readonly CommandArgument[] =>
  pathArgumentGroupsFor(invocation).all;

export const sensitivePathArgumentsFor = (invocation: CommandInvocation): readonly CommandArgument[] =>
  pathArgumentGroupsFor(invocation).sensitive;
