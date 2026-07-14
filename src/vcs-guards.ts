import { execFileSync } from "node:child_process";
import {
  commandBasename,
  type CommandInvocation,
} from "./command-invocation";
import { gitEffectiveCwd, parseGitInvocation } from "./git-invocation";
import { evaluateGhGuard } from "./gh-guards";
import { guardFinding, type GuardFinding } from "./guard-types";

const gitBlock = (invocation: CommandInvocation): GuardFinding | undefined => {
  const parsed = parseGitInvocation(invocation);
  const subcommand = parsed.subcommand ?? "";
  const args = parsed.arguments;
  const lowered = invocation.arguments.map((argument) => argument.toLowerCase());
  if (lowered.some((argument) => argument.includes("core.hookspath="))) {
    return guardFinding("block", "git_hook_bypass", "bypasses git hooks and safety checks");
  }
  if (
    args.some((argument) =>
      argument === "--no-verify" ||
      argument.startsWith("--no-veri") ||
      (subcommand === "commit" && argument.startsWith("--no-post"))
    ) ||
    ((subcommand === "commit" || subcommand === "push") && args.some((argument) => /^-[^-]*n[^-]*$/u.test(argument)))
  ) {
    return guardFinding("block", "git_hook_bypass", "bypasses git hooks and safety checks");
  }
  if (
    subcommand === "clean" ||
    subcommand === "restore" ||
    (subcommand === "reset" && args.some((argument) => argument === "--hard" || argument.startsWith("--har"))) ||
    (subcommand === "checkout" && (args.includes("--") || args.some((argument) => /^-[^-]*f/u.test(argument)))) ||
    (subcommand === "switch" && args.some((argument) => argument.startsWith("--discard")))
  ) {
    return guardFinding("block", "git_discard", "git command can discard user work");
  }
  if (
    subcommand === "push" &&
    args.some((argument) =>
      /^(?:-f|--for|--del|--mir|--pru|:\S+)/u.test(argument),
    )
  ) {
    return guardFinding("block", "git_destructive_push", "destructive git push can alter remote history");
  }
  return undefined;
};

const gitReview = (invocation: CommandInvocation): GuardFinding | undefined => {
  const parsed = parseGitInvocation(invocation);
  const subcommand = parsed.subcommand ?? "";
  const args = parsed.arguments;
  const diffOptions = args.some((argument) =>
    argument === "--output" ||
    argument.startsWith("--output=") ||
    argument === "--ext-diff" ||
    argument.startsWith("--ext-d") ||
    argument === "--textconv" ||
    argument.startsWith("--textc")
  );
  const gpgHelper = args.some((argument, index) => {
    if (argument === "--show-signature" || argument.startsWith("--show-signature=")) return true;
    const format = argument.match(/^--(?:format|pretty)=(.*)$/u)?.[1] ??
      (["--format", "--pretty"].includes(argument) ? args[index + 1] : undefined);
    return format ? /%G./u.test(format) : false;
  });
  const helperDisabled = args.includes("--no-ext-diff") && args.includes("--no-textconv");
  const patchFlag = args.some((argument) => /^(?:-p|-u|--patch|--patch-with-(?:raw|stat)|--cc|-c)$/u.test(argument));
  const diffMetadataOnly = args.some((argument) =>
    /^(?:--check|--name-only|--name-status|--numstat|--raw|--shortstat|--stat|--summary|--quiet)$/u.test(argument)
  ) && !patchFlag;
  const patchMayExecuteHelper =
    (subcommand === "diff" && !diffMetadataOnly && !helperDisabled) ||
    (subcommand === "show" && !args.some((argument) => argument === "-s" || argument === "--no-patch") && !helperDisabled) ||
    (["log", "whatchanged"].includes(subcommand) && patchFlag && !helperDisabled) ||
    (subcommand === "stash" && args[0] === "show" && patchFlag && !helperDisabled);
  if (parsed.unsafeGlobalOptions.length > 0) {
    return guardFinding("review", "git_global_option", "git global option can change helpers, config, or execution behavior");
  }
  if (
    subcommand === "fetch" ||
    subcommand === "push" ||
    subcommand === "checkout" ||
    (subcommand === "commit" && args.some((argument) => argument.startsWith("--no-g"))) ||
    (subcommand === "branch" && args.some((argument) =>
      /^-[^-]*[dDmMcCf]/u.test(argument) || /^--(?:del(?:ete)?|mov(?:e)?|cop(?:y)?|forc(?:e)?)(?:=|$)/u.test(argument)
    )) ||
    (subcommand === "reflog" && ["delete", "drop", "expire"].includes(args[0] ?? "")) ||
    (subcommand === "remote" && args[0] === "show") ||
    gpgHelper ||
    patchMayExecuteHelper ||
    (["diff", "grep"].includes(subcommand) && args.some((argument) => /^-O/u.test(argument))) ||
    (["diff", "log", "show", "whatchanged"].includes(subcommand) && diffOptions) ||
    (subcommand === "diff" && args.some((argument) => argument === "--no-index" || argument.startsWith("--no-inde"))) ||
    (subcommand === "blame" && args.some((argument) =>
      argument === "--contents" || argument.startsWith("--cont") || argument === "--textconv" || argument.startsWith("--textc")
    )) ||
    (subcommand === "stash" && args[0] === "show" && diffOptions) ||
    (subcommand === "grep" && args.some((argument) =>
      argument.startsWith("--open") ||
      argument.startsWith("--textc") ||
      argument === "--no-index" ||
      argument.startsWith("--no-inde")
    ))
  ) {
    return guardFinding("review", "git_effectful_option", "git subcommand or option can write, fetch, or execute a helper");
  }
  const safeInspection = new Set([
    "--help", "--version", "blame", "describe", "diff", "for-each-ref", "grep", "log", "ls-files",
    "ls-tree", "merge-base", "name-rev", "rev-list", "rev-parse", "shortlog", "show", "show-ref",
    "status", "whatchanged",
  ]);
  const listingArguments = (
    values: readonly string[],
    shortFlags: RegExp,
    longFlags: ReadonlySet<string>,
    valueOptions: ReadonlySet<string>,
    explicitOptions: ReadonlySet<string>,
  ): boolean => {
    let explicit = values.length === 0;
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index] ?? "";
      if (explicitOptions.has(value)) {
        explicit = true;
        continue;
      }
      if (shortFlags.test(value)) {
        explicit = true;
        continue;
      }
      if (longFlags.has(value)) continue;
      if (valueOptions.has(value)) {
        explicit = true;
        index += 1;
        continue;
      }
      if ([...valueOptions].some((option) => value.startsWith(`${option}=`))) {
        explicit = true;
        continue;
      }
      if (subcommand === "tag" && /^-n\d*$/u.test(value)) {
        explicit = true;
        continue;
      }
      if (!value.startsWith("-") && explicit) continue;
      return false;
    }
    return explicit;
  };
  const safeBranch = subcommand === "branch" && listingArguments(
    args,
    /^-[arv]+$/u,
    new Set(["--color", "--ignore-case", "--no-color"]),
    new Set(["--column", "--contains", "--format", "--merged", "--no-contains", "--no-merged", "--points-at", "--sort"]),
    new Set(["--all", "--list", "--remotes", "--show-current", "--verbose", "-l"]),
  );
  const safeTag = subcommand === "tag" && listingArguments(
    args,
    /^-l$/u,
    new Set(["--color", "--ignore-case", "--no-color"]),
    new Set(["--column", "--contains", "--format", "--merged", "--no-contains", "--no-merged", "--points-at", "--sort"]),
    new Set(["--list", "-l"]),
  );
  const safeStash = subcommand === "stash" && ["list", "show"].includes(args[0] ?? "");
  if (!(safeInspection.has(subcommand) || subcommand === "commit" || safeBranch || safeTag || safeStash)) {
    return guardFinding("review", "git_effectful", "git subcommand is outside the bounded inspection and signed-commit set");
  }
  return undefined;
};

const gitStatusUsesExternalFsmonitor = (invocation: CommandInvocation, cwd: string): boolean => {
  if (parseGitInvocation(invocation).subcommand !== "status") return false;
  try {
    const value = execFileSync("/usr/bin/git", ["-C", gitEffectiveCwd(invocation, cwd), "config", "--get", "core.fsmonitor"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim();
    return value.length > 0 && !/^(?:false|true)$/iu.test(value);
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
};

export const evaluateVcsGuard = (invocation: CommandInvocation, cwd = process.cwd()): GuardFinding | undefined => {
  const name = commandBasename(invocation);
  if (name === "git") {
    return gitBlock(invocation) ??
      (gitStatusUsesExternalFsmonitor(invocation, cwd)
        ? guardFinding("review", "git_helper", "git status can execute the configured core.fsmonitor helper")
        : gitReview(invocation));
  }
  if (name === "gh") return evaluateGhGuard(invocation);
  return undefined;
};
