import { basename, join } from "node:path";
import { commandBasename, type CommandInvocation } from "./command-invocation";
import { wrapperOutputTargets } from "./command-wrapper-targets";
import { gitConfigTargets } from "./git-config-targets";
import { linkMutationTargets, touchMutationTargets, type RecognizedMutationTargets } from "./mutation-special-targets";
import { outputOptionTargets, type OutputTargetAnalysis } from "./output-option-targets";

export type MutationTargetAnalysis =
  | RecognizedMutationTargets
  | { readonly ambiguous: false; readonly exactTargets: readonly []; readonly recognized: false };

const pathWriters = new Set(["chmod", "chown", "mv", "rm", "truncate", "unlink"]);
const directoryDestinations = new Set(["cp", "install", "mv", "rsync"]);
const targetDirectoryWriters = new Set(["cp", "install", "mv"]);
const interpreters = new Set([
  "awk", "bash", "bun", "deno", "gawk", "lua", "mawk", "node", "perl", "php", "python", "python3", "ruby", "sh", "zsh",
]);
const observers = new Set([
  "[", "cat", "cmp", "diff", "echo", "find", "grep", "head", "less", "ls", "more", "printf", "readlink", "realpath", "rg",
  "sha1sum", "sha256sum", "shasum", "stat", "tail", "test", "wc",
]);
const rsyncOptionsWithValues = new Set([
  "-B", "-e", "-f", "-M", "-T", "--address", "--backup-dir", "--block-size", "--bwlimit", "--checksum-choice",
  "--checksum-seed", "--chmod", "--compare-dest", "--compress-choice", "--compress-level", "--contimeout", "--copy-as",
  "--copy-dest", "--debug", "--exclude", "--exclude-from", "--files-from", "--filter", "--groupmap", "--iconv", "--include",
  "--include-from", "--info", "--link-dest", "--log-file", "--log-file-format", "--max-alloc", "--max-delete", "--max-size",
  "--min-size", "--modify-window", "--out-format", "--partial-dir", "--password-file", "--port", "--protocol", "--read-batch",
  "--remote-option", "--rsync-path", "--sockopts", "--suffix", "--temp-dir", "--timeout", "--usermap", "--write-batch",
  "--only-write-batch",
]);
const curlOutputOptions = new Set(["-o", "--output"]);
const wgetOutputOptions = new Set(["-O", "--output-document"]);
const findOutputOptions = new Set(["-fls", "-fprint", "-fprint0", "-fprintf"]);
const gitArchiveOutputOptions = new Set(["-o", "--output"]);
const rsyncOutputOptions = new Set(["--log-file", "--only-write-batch", "--write-batch"]);

type DestinationVariant = {
  readonly destination: string;
  readonly sources: readonly string[];
};

type DestinationState = {
  readonly operands: readonly string[];
  readonly optionsEnded: boolean;
  readonly pendingValue: "option" | "target-directory" | undefined;
  readonly targetDirectory: string | undefined;
};

const commandName = (invocation: Pick<CommandInvocation, "commandName">): string =>
  commandBasename(invocation).toLowerCase();

const hasDynamicArguments = (invocation: CommandInvocation): boolean =>
  invocation.argumentWords.some((word) => !word.expansionFree);

const nonOptionArguments = (invocation: CommandInvocation): readonly string[] => {
  const operands: string[] = [];
  let optionsEnded = false;
  for (const argument of invocation.arguments) {
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
    } else if (optionsEnded || !argument.startsWith("-")) {
      operands.push(argument);
    }
  }
  return operands;
};

const destinationVariants = (invocation: CommandInvocation): readonly DestinationVariant[] => {
  const name = commandName(invocation);
  const supportsTargetDirectory = targetDirectoryWriters.has(name);
  let states: readonly DestinationState[] = [{ operands: [], optionsEnded: false, pendingValue: undefined, targetDirectory: undefined }];
  for (const argument of invocation.arguments) {
    const next = states.flatMap((state): readonly DestinationState[] => {
      if (state.pendingValue === "target-directory") return [{ ...state, pendingValue: undefined, targetDirectory: argument }];
      if (state.pendingValue === "option") return [{ ...state, pendingValue: undefined }];
      if (!state.optionsEnded && argument === "--") return [{ ...state, optionsEnded: true }];
      if (state.optionsEnded || !argument.startsWith("-")) return [{ ...state, operands: [...state.operands, argument] }];
      if (supportsTargetDirectory && (argument === "-t" || argument === "--target-directory")) {
        return [{ ...state, pendingValue: "target-directory" }];
      }
      const attached = supportsTargetDirectory ? /^(?:-t|--target-directory=)(.+)$/u.exec(argument)?.[1] : undefined;
      if (attached) return [{ ...state, targetDirectory: attached }];
      if (argument.includes("=") || (name === "rsync" && /^-(?:B|e|f|M|T).+/u.test(argument))) return [state];
      if (name === "rsync" && rsyncOptionsWithValues.has(argument)) return [{ ...state, pendingValue: "option" }];
      return [state, { ...state, pendingValue: "option" }];
    });
    const unique = new Map<string, DestinationState>();
    for (const state of next) {
      unique.set(`${String(state.optionsEnded)}:${state.pendingValue ?? "-"}:${state.targetDirectory ?? "-"}:${state.operands.join("\0")}`, state);
    }
    if (unique.size > 64) return nonOptionArguments(invocation).map((destination) => ({ destination, sources: [] }));
    states = [...unique.values()];
  }
  return states.flatMap((state) => {
    if (state.targetDirectory) return [{ destination: state.targetDirectory, sources: state.operands }];
    const destination = state.operands.at(-1);
    return destination ? [{ destination, sources: state.operands.slice(0, -1) }] : [];
  });
};

const destinationTargets = (invocation: CommandInvocation): readonly string[] => {
  const variants = destinationVariants(invocation);
  if (variants.length === 0) return nonOptionArguments(invocation);
  return variants.flatMap((entry) => [
    entry.destination,
    ...entry.sources.map((source) => join(entry.destination, basename(source))),
  ]);
};

const recognizedOutput = (analysis: OutputTargetAnalysis): MutationTargetAnalysis => ({ ...analysis, recognized: true });

const gitTargets = (invocation: CommandInvocation): MutationTargetAnalysis => {
  const subcommand = invocation.arguments[0];
  if (!subcommand) return { ambiguous: false, exactTargets: [], recognized: true };
  if (subcommand.startsWith("-")) return { ambiguous: true, exactTargets: [], recognized: true };
  if (subcommand === "config") {
    return recognizedOutput(gitConfigTargets(invocation.argumentWords.slice(1)));
  }
  if (subcommand === "archive") {
    return recognizedOutput(outputOptionTargets(invocation.argumentWords.slice(1), gitArchiveOutputOptions));
  }
  if (subcommand === "bundle" && invocation.arguments[1] === "create") {
    const words = invocation.argumentWords.slice(2);
    let optionsEnded = false;
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      if (!word) continue;
      if (!optionsEnded && word.value === "--") {
        optionsEnded = true;
        continue;
      }
      if (!optionsEnded && word.value === "--version") {
        index += 1;
        continue;
      }
      if (!optionsEnded && word.value !== "-" && word.value.startsWith("-")) continue;
      return { ambiguous: !word.expansionFree, exactTargets: [word.value], recognized: true };
    }
    return { ambiguous: false, exactTargets: [], recognized: true };
  }
  if (["am", "apply", "cherry-pick", "clean", "merge", "pull", "rebase", "reset", "revert", "stash", "switch", "worktree"].includes(subcommand)) {
    return { ambiguous: true, exactTargets: [], recognized: true };
  }
  if (subcommand === "mv" || subcommand === "rm") {
    const targets = nonOptionArguments(invocation).slice(1);
    return {
      ambiguous: hasDynamicArguments(invocation) || targets.some((target) => target === "." || target === ".."),
      exactTargets: targets,
      recognized: true,
    };
  }
  if (subcommand === "checkout") {
    const separator = invocation.arguments.indexOf("--");
    const targets = separator < 0 ? [] : invocation.arguments.slice(separator + 1);
    return separator < 0
      ? { ambiguous: true, exactTargets: [], recognized: true }
      : { ambiguous: hasDynamicArguments(invocation) || targets.some((target) => target === "." || target === ".."), exactTargets: targets, recognized: true };
  }
  if (subcommand === "restore") {
    const separator = invocation.arguments.indexOf("--");
    const values = separator < 0 ? nonOptionArguments(invocation).slice(1) : invocation.arguments.slice(separator + 1);
    return values.length > 0
      ? {
          ambiguous: hasDynamicArguments(invocation) || values.some((target) => target === "." || target === ".."),
          exactTargets: values,
          recognized: true,
        }
      : { ambiguous: true, exactTargets: [], recognized: true };
  }
  return { ambiguous: false, exactTargets: [], recognized: true };
};

const archiveExtraction = (name: string, args: readonly string[]): boolean => {
  if (["tar", "bsdtar", "gtar"].includes(name)) return args.some((argument) => argument === "--extract" || argument === "--get" || /^-[^-]*x/u.test(argument));
  if (name === "unzip") return !args.some((argument) => ["-l", "-t", "-v", "-Z"].includes(argument));
  if (name === "7z" || name === "7za") return args[0] === "e" || args[0] === "x";
  if (name === "jar") return args.some((argument) => /^-[^-]*x/u.test(argument) || argument === "x");
  return name === "cpio" && args.some((argument) => /^-[^-]*i/u.test(argument));
};

const directMutationTargets = (invocation: CommandInvocation): MutationTargetAnalysis => {
  const name = commandName(invocation);
  const dynamicArguments = hasDynamicArguments(invocation);
  if (interpreters.has(name) || archiveExtraction(name, invocation.arguments)) {
    return { ambiguous: true, exactTargets: [], recognized: true };
  }
  if (name === "git") return gitTargets(invocation);
  if (name === "curl") return recognizedOutput(outputOptionTargets(invocation.argumentWords, curlOutputOptions));
  if (name === "wget") return recognizedOutput(outputOptionTargets(invocation.argumentWords, wgetOutputOptions));
  if (name === "find") return recognizedOutput(outputOptionTargets(invocation.argumentWords, findOutputOptions));
  if (name === "ln") return linkMutationTargets(invocation);
  if (name === "touch") return touchMutationTargets(invocation);
  if (name === "mv") {
    return {
      ambiguous: dynamicArguments,
      exactTargets: [...nonOptionArguments(invocation), ...destinationTargets(invocation)],
      recognized: true,
    };
  }
  if (name === "rm") {
    return {
      ambiguous: dynamicArguments || invocation.arguments.some((value) => value === "--recursive" || /^-[^-]*[rR]/u.test(value)),
      exactTargets: nonOptionArguments(invocation),
      recognized: true,
    };
  }
  if (name === "rsync") {
    const outputs = outputOptionTargets(invocation.argumentWords, rsyncOutputOptions);
    return {
      ambiguous: dynamicArguments || outputs.ambiguous,
      exactTargets: [
        ...(invocation.arguments.includes("--remove-source-files") ? nonOptionArguments(invocation) : []),
        ...destinationTargets(invocation),
        ...outputs.exactTargets,
      ],
      recognized: true,
    };
  }
  if (directoryDestinations.has(name)) return { ambiguous: dynamicArguments, exactTargets: destinationTargets(invocation), recognized: true };
  if (pathWriters.has(name)) return { ambiguous: dynamicArguments, exactTargets: nonOptionArguments(invocation), recognized: true };
  if (name === "tee") return { ambiguous: dynamicArguments, exactTargets: nonOptionArguments(invocation), recognized: true };
  if (name === "dd") {
    return {
      ambiguous: dynamicArguments,
      exactTargets: invocation.arguments.filter((value) => value.startsWith("of=")).map((value) => value.slice(3)),
      recognized: true,
    };
  }
  if (name === "sed" && invocation.arguments.some((value) => value === "-i" || value.startsWith("-i") || value.startsWith("--in-place"))) {
    return { ambiguous: dynamicArguments, exactTargets: nonOptionArguments(invocation), recognized: true };
  }
  return { ambiguous: false, exactTargets: [], recognized: false };
};

export const mutationTargets = (invocation: CommandInvocation): MutationTargetAnalysis => {
  const direct = directMutationTargets(invocation);
  const wrappers = invocation.wrapperChain.map(wrapperOutputTargets);
  if (wrappers.every((analysis) => !analysis.ambiguous && analysis.exactTargets.length === 0)) return direct;
  return {
    ambiguous: direct.ambiguous || wrappers.some((analysis) => analysis.ambiguous),
    exactTargets: [...wrappers.flatMap((analysis) => analysis.exactTargets), ...direct.exactTargets],
    recognized: true,
  };
};

export const isProvenObserver = (invocation: CommandInvocation): boolean => observers.has(commandName(invocation));
