import {
  dateMaySetOrReadList,
  invokesNestedShellScript,
  swiftInvocationNeedsReview,
  xcodebuildLoadsExternalConfiguration,
} from "./command-risk-helpers";
import { developerToolLoadsExternalHelper } from "./developer-tool-guards";
import {
  commandArguments,
  commandBasename,
  dispatchedInvocationForGuards,
  environmentAssignmentNeedsReview,
  effectiveInvocation,
  invocationFromSegment,
  type CommandInvocation,
} from "./command-invocation";
import { guardFinding, type GuardFinding } from "./guard-types";
import { evaluateCommonBlock } from "./mandatory-blocks";
import {
  evaluateExecutableGuard,
  evaluateRedirectionGuard,
  evaluateReaderPathGuard,
  evaluateSedGuard,
  jqPrograms,
  searchTraversalFinding,
} from "./path-safety";
import { hasShortOption, type ShortOptionRole } from "./short-options";
import { shellInputInvocations, shellNames, shellNeedsExecutionReview } from "./shell-invocation";
import type { ShellAnalysis, ShellSegment } from "./types";
import { evaluateVcsGuard } from "./vcs-guards";
import { resolveXcrunTool, xcrunDispatchNeedsReview } from "./xcrun-trust";

export type { GuardFinding } from "./guard-types";

const pipeToShell = (analysis: ShellAnalysis): boolean => analysis.segments.some((segment) => {
  if (segment.nested || !segment.stdinFromPipe) return false;
  const invocation = effectiveInvocation(invocationFromSegment(segment));
  return shellNames.has(commandBasename(dispatchedInvocationForGuards(invocation) ?? invocation));
});

const fileShortRoles: Readonly<Record<string, ShortOptionRole>> = {
  e: "value", f: "path", F: "value", m: "path", M: "path", P: "value",
};
const sortShortRoles: Readonly<Record<string, ShortOptionRole>> = { k: "value", o: "path", t: "value", T: "path" };
const base64ShortRoles: Readonly<Record<string, ShortOptionRole>> = { b: "value", i: "path", o: "path" };

const printfSetsVariable = (invocation: CommandInvocation): boolean => {
  if (invocation.commandName !== "printf") return false;
  const first = invocation.arguments[0] ?? "";
  return first === "-v" || /^-v[^-].+/u.test(first);
};

const commonReview = (segment: ShellSegment, invocation: CommandInvocation, cwd: string): GuardFinding | undefined => {
  const name = commandBasename(invocation);
  const args = invocation.arguments;
  if (invocation.reviewReasons[0]) return guardFinding("review", "shell_wrapper", invocation.reviewReasons[0]);
  const riskyAssignment = segment.environment.find((assignment) =>
    environmentAssignmentNeedsReview(assignment.name, invocation.commandName, assignment.value)
  );
  if (riskyAssignment) {
    return guardFinding("review", "environment_assignment", `environment assignment ${riskyAssignment.name} can change executable or helper behavior`);
  }
  if (["cd", "dirs", "popd", "pushd"].includes(name)) {
    return guardFinding("review", "directory_change", "directory-changing shell commands make later relative paths context-dependent");
  }
  if (["arch", "caffeinate", "nice", "nohup", "parallel", "script", "ssh", "stdbuf", "time", "timeout", "xargs"].includes(name) ||
      (name === "launchctl" && args[0] === "submit") ||
      (name === "find" && args.some((argument) => /^(?:-exec|-execdir|-ok|-okdir)$/u.test(argument)))) {
    return guardFinding("review", "process_dispatch", "process-dispatch command can hide a nested executable from static guards");
  }
  if (invokesNestedShellScript(name, args)) {
    return guardFinding("review", "nested_shell", "nested shell startup state is outside static command analysis");
  }
  if (["fish", "powershell", "pwsh"].includes(name)) return guardFinding("review", "alternate_shell", "non-Bash shell execution cannot be statically analyzed");
  if (name === "xcrun" && xcrunDispatchNeedsReview(invocation, segment.environment)) {
    return guardFinding("review", "xcrun_dispatch", "xcrun resolves this tool outside the selected Xcode developer directory");
  }
  if (swiftInvocationNeedsReview(name, args)) {
    return guardFinding("review", "swift_script", "Swift script execution requires contextual review");
  }
  if (developerToolLoadsExternalHelper(name, args)) {
    return guardFinding("review", "compiler_helper", "compiler option can load executable helpers or hidden response-file arguments");
  }
  if (xcodebuildLoadsExternalConfiguration(name, args)) {
    return guardFinding("review", "xcodebuild_configuration", "Xcode build settings can load external configuration or executable helpers");
  }
  if (name === "rg" && args.some((argument) => /^(?:--pre|--hostname-bin)(?:=|$)/u.test(argument))) {
    return guardFinding("review", "rg_helper", "ripgrep option can execute an external helper");
  }
  if (name === "rg" && args.some((argument) => /^(?:--search-zip|-[^-]*z)(?:=|$)/u.test(argument))) {
    return guardFinding("review", "rg_decompressor", "ripgrep compressed-file search can execute external decompressors");
  }
  if (name === "rg" && args.some((argument) => argument === "--follow" || /^-[^-]*L/u.test(argument))) {
    return guardFinding("review", "symlink_traversal", "recursive reader follows symlinks outside the working tree");
  }
  if (["grep", "egrep", "fgrep"].includes(name) && args.some((argument) => argument === "--dereference-recursive" || /^-[^-]*R/u.test(argument))) {
    return guardFinding("review", "symlink_traversal", "recursive reader follows symlinks outside the working tree");
  }
  if (name === "rg" && process.env["RIPGREP_CONFIG_PATH"] && !args.includes("--no-config")) {
    return guardFinding("review", "rg_config", "ripgrep configuration can enable external helpers");
  }
  if (searchTraversalFinding(invocation, cwd) === "limit") {
    return guardFinding("review", "external_read", "recursive search exceeded the bounded sensitive-path scan");
  }
  const pairs = commandArguments(invocation);
  if (name === "sort" && (hasShortOption(pairs, "o", sortShortRoles) || hasShortOption(pairs, "T", sortShortRoles) || args.some((argument) =>
    argument.startsWith("--output") ||
    argument.startsWith("--compress-program") ||
    argument.startsWith("--temporary-directory")
  ))) {
    return guardFinding("review", "sort_output", "sort output or compressor options can write files or execute helpers");
  }
  if (["sort", "wc"].includes(name) && args.some((argument) => argument.startsWith("--files0-from"))) {
    return guardFinding("review", "indirect_input", "file list contents can reference paths outside the working directory");
  }
  if (name === "base64" && (hasShortOption(pairs, "o", base64ShortRoles) || args.some((argument) => argument.startsWith("--output")))) {
    return guardFinding("review", "base64_output", "base64 output options write files");
  }
  if (name === "file" && (hasShortOption(pairs, "C", fileShortRoles) || args.includes("--compile"))) {
    return guardFinding("review", "file_compile", "file --compile writes a magic database");
  }
  if (name === "file" && (
    hasShortOption(pairs, "f", fileShortRoles) ||
    hasShortOption(pairs, "z", fileShortRoles) ||
    hasShortOption(pairs, "Z", fileShortRoles) ||
    hasShortOption(pairs, "S", fileShortRoles) ||
    args.some((argument) =>
    argument.startsWith("--files-from") ||
    ["--uncompress", "--uncompress-noreport", "-S", "--no-sandbox"].includes(argument)
  ))) {
    return guardFinding("review", "file_indirect", "file option can execute a decompressor, disable isolation, or read an indirect path list");
  }
  if (name === "jq" && args.some((argument) => /^(?:-L|-f)(?:.+)?$|^--from-file(?:=|$)/u.test(argument))) {
    return guardFinding("review", "jq_program_file", "jq external program or module files require review");
  }
  if (name === "jq" && jqPrograms(invocation).some((program) => /(?:^|[;|,\s])(?:import|include|modulemeta)(?:\s|\()/u.test(program))) {
    return guardFinding("review", "jq_module", "jq module loading requires review");
  }
  if (name === "jq" && args.some((argument) => argument.startsWith("--run-tests"))) {
    return guardFinding("review", "jq_tests", "jq test programs are loaded from an external file");
  }
  if (["shasum", "cksum"].includes(name) && (hasShortOption(pairs, "c") || args.includes("--check"))) {
    return guardFinding("review", "checksum_manifest", "checksum manifests can reference files outside the working directory");
  }
  if (name === "date" && (hasShortOption(pairs, "s", { s: "value" }) || dateMaySetOrReadList(args))) {
    return guardFinding("review", "date_set", "date arguments can set system time or read an indirect input list");
  }
  if (name === "ffprobe" && (args.some((argument) => /(?:^|[=,])[A-Za-z][A-Za-z0-9+.-]*\\?:/iu.test(argument) || /(?:^|[=,])a?movie=/iu.test(argument)) || args.some((argument, index) => argument === "-f" && args[index + 1] === "lavfi"))) {
    return guardFinding("review", "ffprobe_protocol", "ffprobe protocol or filter input requires review");
  }
  if (name === "ffprobe" && args.some((argument) => argument === "-o" || /^-o=.+/u.test(argument) || argument === "-report")) {
    return guardFinding("review", "ffprobe_output", "ffprobe option writes an output or report file");
  }
  if (name === "printf" && printfSetsVariable(invocation)) {
    return guardFinding("review", "shell_state", "shell printf -v changes shell variables used by later segments");
  }
  if (name === "sed") {
    const sed = evaluateSedGuard(invocation);
    if (sed) return sed;
  }
  if (name === "dd" && args.some((argument) => /^of=/u.test(argument))) {
    return guardFinding("review", "filesystem_write", "dd output writes directly to a caller-selected path");
  }
  const scriptInputs = shellInputInvocations(invocation);
  for (const scriptInput of scriptInputs) {
    const scriptGuard = evaluateReaderPathGuard(scriptInput, cwd);
    if (scriptGuard) return scriptGuard;
  }
  if (shellNeedsExecutionReview(invocation)) {
    return guardFinding("review", "shell_script", "shell execution or startup state requires contextual review");
  }
  const redirection = evaluateRedirectionGuard(segment.redirections, cwd);
  if (redirection) return redirection;
  if (["mkdir", "touch", "cp", "mv", "ln", "tee", "install"].includes(name)) return guardFinding("review", "filesystem_write", "filesystem-writing command requires review without a sandbox");
  return evaluateReaderPathGuard(invocation, cwd) ?? evaluateExecutableGuard(invocation, cwd);
};

export const evaluateMandatoryGuards = (analysis: ShellAnalysis, cwd = process.cwd()): readonly GuardFinding[] => {
  const findings: GuardFinding[] = [];
  for (const nested of analysis.nestedAnalyses) findings.push(...evaluateMandatoryGuards(nested, cwd));
  const analysisRedirection = evaluateRedirectionGuard(analysis.redirections, cwd);
  if (analysisRedirection) findings.push(analysisRedirection);
  if (pipeToShell(analysis)) findings.push(guardFinding("block", "pipe_to_shell", "pipes generated or downloaded content into a shell"));
  for (const segment of analysis.segments) {
    const invocation = effectiveInvocation(invocationFromSegment(segment));
    const dispatched = commandBasename(invocation) === "xcrun"
      ? resolveXcrunTool(invocation, segment.environment)?.invocation ?? dispatchedInvocationForGuards(invocation)
      : dispatchedInvocationForGuards(invocation);
    const invocations = dispatched ? [invocation, dispatched] : [invocation];
    const blocked = invocations.map((entry) => evaluateCommonBlock(segment, entry, cwd)).find(Boolean);
    const vcsFindings = invocations.map((entry) => evaluateVcsGuard(entry, cwd)).filter((entry): entry is GuardFinding => Boolean(entry));
    const vcsBlock = vcsFindings.find((entry) => entry.decision === "block");
    if (blocked) findings.push(blocked);
    else if (vcsBlock) findings.push(vcsBlock);
    else {
      const guarded = invocations.map((entry) => commonReview(segment, entry, cwd)).find(Boolean);
      const segmentFindings = [...vcsFindings, guarded].filter((finding): finding is GuardFinding => Boolean(finding));
      const strongest = segmentFindings.find((finding) => finding.decision === "block") ?? segmentFindings[0];
      if (strongest) findings.push(strongest);
    }
  }
  const identities = new Set<string>();
  return findings.filter((entry): entry is GuardFinding => {
    if (!entry) return false;
    const identity = `${entry.decision}:${entry.category.id}:${entry.reason}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
};
