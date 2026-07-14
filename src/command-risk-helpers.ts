import { environmentAssignmentNeedsReview } from "./command-invocation";
import { developerToolLoadsExternalHelper } from "./developer-tool-guards";

const staticallyAnalyzedShells = new Set(["ash", "bash", "dash", "ksh", "mksh", "sh", "zsh"]);
const swiftPackageSubcommands = new Set([
  "add-dependency", "add-product", "add-setting", "add-target", "add-target-dependency",
  "archive-source", "clean", "completion-tool", "compute-checksum", "config",
  "diagnose-api-breaking-changes", "describe", "dump-package", "dump-symbol-graph", "edit",
  "experimental-audit-binary-artifact", "experimental-install", "experimental-uninstall", "init",
  "migrate", "purge-cache", "reset", "resolve", "show-dependencies", "show-executables",
  "show-traits", "tools-version", "unedit", "update",
]);
const swiftPackageValueOptions = new Set([
  "--build-system", "--cache-path", "--configuration", "--config-path", "--debug-info-format",
  "--default-registry-url", "--explicit-target-dependency-import-check", "--jobs",
  "--manifest-cache", "--netrc-file", "--package-path", "--pkg-config-path",
  "--resolver-fingerprint-checking", "--resolver-signing-entity-checking", "--sanitize",
  "--scratch-path", "--security-path", "--swift-sdk", "--swift-sdks-path", "--toolchain",
  "--toolset", "--traits", "--triple", "-Xcc", "-Xcxx", "-Xlinker", "-Xswiftc", "-c", "-j",
]);

export const invokesNestedShellScript = (name: string, args: readonly string[]): boolean =>
  staticallyAnalyzedShells.has(name) && args.some((argument) => /^-[^-]*c/u.test(argument));

const swiftPackageSubcommand = (args: readonly string[]): string | undefined => {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--") return args[index + 1];
    if (swiftPackageValueOptions.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    return argument;
  }
  return undefined;
};

const swiftExecutionNeedsReview = (tool: string, args: readonly string[]): boolean => {
  if (developerToolLoadsExternalHelper(tool, args)) return true;
  if (["swiftc", "swift-driver"].includes(tool)) {
    return args.some((argument) =>
      /^(?:-{1,2}driver-mode=swift|-interpret|-lldb-repl|-repl)$/u.test(argument)
    );
  }
  if (tool === "swift-frontend") {
    if (args.length === 0 || args.some((argument) => ["-interpret", "-lldb-repl", "-repl"].includes(argument))) return true;
    return !args.some((argument) =>
      ["-dump-parse", "-help", "-parse", "-scan-dependencies", "-typecheck", "--version"].includes(argument) ||
      argument.startsWith("-emit-") || argument.startsWith("-print-")
    );
  }
  return false;
};

export const swiftInvocationNeedsReview = (tool: string, toolArguments: readonly string[]): boolean => {
  if (["swift-frontend", "swiftc", "swift-driver"].includes(tool)) {
    return swiftExecutionNeedsReview(tool, toolArguments);
  }
  if (tool !== "swift") return false;
  if (swiftExecutionNeedsReview(tool, toolArguments)) return true;
  const mode = toolArguments[0] ?? "";
  if (mode === "package") {
    const subcommand = swiftPackageSubcommand(toolArguments.slice(1));
    return subcommand !== undefined && !swiftPackageSubcommands.has(subcommand);
  }
  if (["build", "experimental-sdk", "package-registry", "sdk", "test"].includes(mode)) return false;
  if (["run", "repl", "-repl", "-lldb-repl"].includes(mode) || toolArguments.length === 0) return true;
  if (toolArguments.some((argument) => ["-e", "-interpret", "-lldb-repl", "-repl", "-"].includes(argument))) return true;
  const compileOnly = toolArguments.some((argument) =>
    ["-c", "-parse", "-typecheck", "-o"].includes(argument) || argument.startsWith("-emit-")
  );
  const source = toolArguments.find((argument) => !argument.startsWith("-"));
  return source !== undefined && !compileOnly;
};

const xcodeHelperSettings = /^(?:AR|AS|CC|CCC_ADD_ARGS|CCC_OVERRIDE_OPTIONS|COMPILER_PATH|CPP|CXX|GCC_EXEC_PREFIX|LD|LEX|LIBTOOL|MIG|NM|RANLIB|RPCGEN|SHELL|STRIP|SWIFT_EXEC|SWIFTC_EXEC|SWIFT_DRIVER_.+_EXEC|XCODE_XCCONFIG_FILE|YACC)$/u;
const appleSdkName = /^(?:appletvos|appletvsimulator|iphoneos|iphonesimulator|macosx|watchos|watchsimulator|xros|xrsimulator)(?:\d+(?:\.\d+)*)?$/iu;
const defaultToolchains = new Set(["XcodeDefault", "com.apple.dt.toolchain.XcodeDefault"]);

const injectedCompilerFlags = (value: string): boolean =>
  developerToolLoadsExternalHelper("swiftc", value.trim().split(/\s+/u).filter(Boolean)) ||
  developerToolLoadsExternalHelper("clang", value.trim().split(/\s+/u).filter(Boolean));

const xcodebuildSettingNeedsReview = (argument: string): boolean => {
  const setting = argument.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
  const name = setting?.[1];
  const value = setting?.[2] ?? "";
  if (!name) return false;
  if (name === "TOOLCHAINS") return !defaultToolchains.has(value);
  if (name === "SDKROOT") return !appleSdkName.test(value);
  if (environmentAssignmentNeedsReview(name, "xcodebuild", value) || xcodeHelperSettings.test(name)) return true;
  return /^(?:OTHER_(?:C|CPLUSPLUS|LD|LIBTOOL)FLAGS|OTHER_SWIFT_FLAGS)$/u.test(name) && injectedCompilerFlags(value);
};

const xcodebuildUsesCustomSelector = (args: readonly string[]): boolean => {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    const separate = argument === "-sdk" ? "sdk" : argument === "-toolchain" ? "toolchain" : undefined;
    const attached = argument.match(/^-(sdk|toolchain)=(.*)$/u);
    const kind = separate ?? attached?.[1];
    if (!kind) continue;
    const value = separate ? args[index += 1] : attached?.[2];
    if (!value || value.startsWith("-")) continue;
    if (kind === "sdk" ? !appleSdkName.test(value) : !defaultToolchains.has(value)) return true;
  }
  return false;
};

export const xcodebuildLoadsExternalConfiguration = (name: string, args: readonly string[]): boolean => {
  if (name !== "xcodebuild") return false;
  return xcodebuildUsesCustomSelector(args) || args.some((argument) =>
    /^-xcconfig(?:=|$)/u.test(argument) || xcodebuildSettingNeedsReview(argument) ||
    ["-skipMacroValidation", "-skipPackagePluginValidation", "-skipPackageSignatureValidation"].includes(argument)
  );
};

export const dateMaySetOrReadList = (args: readonly string[]): boolean => {
  if (args.some((argument) => /^(?:-s.*|--(?:set|file)(?:=.*)?)$/u.test(argument))) return true;
  const noSet = args.some((argument) => /^-[^-]*j/u.test(argument));
  const valueOptions = new Set(["-d", "--date", "-r", "--reference", "-z"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (valueOptions.has(argument)) {
      index += 1;
      continue;
    }
    if (argument === "--" || argument.startsWith("-")) continue;
    if (!argument.startsWith("+") && !noSet) return true;
  }
  return false;
};
