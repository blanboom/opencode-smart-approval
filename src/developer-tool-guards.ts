const compilerTools = new Set([
  "c++", "c89", "c99", "cc", "clang", "clang++", "clang-cache", "clang-cl", "cpp", "g++", "gcc",
]);
const fileReadingTools = new Set([
  ...compilerTools, "appintentsmetadataprocessor", "bison", "clang-cas-test", "clangd", "dsymutil", "ld", "llvm-cas",
  "llvm-cov", "llvm-otool", "mig", "otool", "rpcgen", "sourcekit-lsp", "tapi", "xccov", "xctrace",
]);
const genericHostDispatch = new Set([
  "agent", "ba-serve", "bun", "clang-format-diff.py", "cmake", "git-shell", "gmake", "gm4", "jsc",
  "lldb", "lldb-dap", "m4", "make", "mcpbridge", "metal-package-builder", "ninja", "node", "opendiff", "osascript",
  "perl", "php", "ruby", "scalar", "swift-build-tool", "swift-plugin-server", "xcdebug",
  "xctest", "xed",
]);

export const isDeveloperCompiler = (name: string): boolean => compilerTools.has(name);

const isSwiftDeveloperTool = (name: string): boolean =>
  name === "swift" || name === "swiftc" || name === "swift-frontend" || name.startsWith("swift-");

export const developerToolReadsFiles = (name: string): boolean =>
  fileReadingTools.has(name) || isSwiftDeveloperTool(name);

const compilerLoadsHelper = (args: readonly string[]): boolean => {
  const linkerArguments = args.flatMap((argument, index) => {
    if (argument === "-Xlinker") return args[index + 1] ? [args[index + 1] ?? ""] : [];
    const attached = argument.match(/^-Xlinker=(.*)$/u)?.[1];
    return attached ? [attached] : [];
  });
  return args.some((argument) =>
    argument.startsWith("@") ||
    /^(?:--?config)(?:=|$)|^--config-(?:system|user)-dir(?:=|$)|^-B(?:.*)$|^(?:--gcc-toolchain|--ld-path|-fuse-ld)(?:=|$)|^(?:-ccc-(?:gcc-name|install-dir)|-fcas-plugin-path|-f(?:pass-)?plugin|--hipspv-pass-plugin|-ivfsoverlay|-vfsoverlay)(?:=|$)|^-Xclang(?:=|$)|^-(?:add-plugin|load|load-pass-plugin|plugin)(?:=|$)/u.test(argument) ||
    /^-Wl,.*(?:@|lto_library|load|plugin)/u.test(argument)
  ) || linkerArguments.some((argument) => /^(?:@|.*(?:lto_library|load|plugin))/u.test(argument));
};

const swiftLoadsHelper = (args: readonly string[]): boolean => args.some((argument) =>
  argument.startsWith("@") ||
  /(?:^|-)plugin(?:-|$)|^(?:--swift-sdk|--swift-sdks-path|--toolchain|--toolset|-Xcc|-Xclang-linker|-Xfrontend|-Xlinker|-Xllvm|-Xswiftc|-driver-use-frontend-path|-filelist|-gcc-toolchain|-in-process-plugin-server-path|-ivfsoverlay|-ld-path|-load-pass-plugin|-load-resolved-plugin|-lto-library|-tools-directory|-use-ld|-vfsoverlay)(?:=|$)/u.test(argument)
);

const optionValue = (args: readonly string[], index: number, name: string): string | undefined => {
  const argument = args[index] ?? "";
  if (argument === name) return args[index + 1];
  return argument.match(new RegExp(`^${name}=(.*)$`, "u"))?.[1];
};

const xccovLoadsCustomToolchain = (args: readonly string[]): boolean => args.some((_, index) => {
  const value = optionValue(args, index, "--toolchain");
  return value !== undefined && !["XcodeDefault", "com.apple.dt.toolchain.XcodeDefault"].includes(value);
});

const xctraceLoadsExternalPackage = (args: readonly string[]): boolean => args.some((_, index) => {
  if (optionValue(args, index, "--package") !== undefined) return true;
  const template = optionValue(args, index, "--template");
  return template !== undefined && (/^(?:[./~]|[A-Za-z]:[\\/])/u.test(template) || /\.(?:instrpkg|tracetemplate)$/iu.test(template));
});

export const developerToolLoadsExternalHelper = (name: string, args: readonly string[]): boolean => {
  if (isDeveloperCompiler(name)) return compilerLoadsHelper(args);
  if (isSwiftDeveloperTool(name)) return swiftLoadsHelper(args);
  if (name === "appintentsmetadataprocessor") {
    return args.some((argument) => /^-c(?:=|$)|^--toolchain-dir(?:=|$)/u.test(argument));
  }
  if (["clang-cas-test", "clangd", "dsymutil", "llvm-cas", "llvm-cov", "sourcekit-lsp", "tapi"].includes(name) &&
      args.some((argument) => argument.startsWith("@"))) return true;
  if (["clang-cas-test", "dsymutil", "llvm-cas"].includes(name)) {
    return args.some((argument) => /^(?:--?f?cas-plugin-path)(?:=|$)/u.test(argument));
  }
  if (name === "llvm-cov") return args.some((argument) => /^--?Xdemangler(?:=|$)/u.test(argument));
  if (["llvm-otool", "otool"].includes(name)) {
    return args.some((argument) => /^-object-tool-path(?:=|$)/u.test(argument));
  }
  if (name === "ld") return args.some((argument) => argument.startsWith("@") || /^-lto_library(?:=|$)/u.test(argument));
  if (name === "mig") return args.some((argument) => /^-(?:cc|migcom)(?:=|$)/u.test(argument));
  if (name === "rpcgen") return args.some((argument) => /^-Y(?:.*)$/u.test(argument));
  if (name === "clangd") return args.some((argument) => /^--query-driver(?:=|$)/u.test(argument));
  if (name === "sourcekit-lsp") return args.some((argument) =>
    /^--query-driver(?:=|$)|^-X(?:cc|clangd|cxx|linker|swiftc)(?:=|$)/u.test(argument)
  );
  if (name === "tapi") return args.some((argument) => /^-Xparser(?:=|$)/u.test(argument));
  if (name === "xccov") return xccovLoadsCustomToolchain(args);
  if (name === "xctrace") return xctraceLoadsExternalPackage(args);
  if (name === "bison") return args.some((argument) => /^(?:-S.*|--skeleton(?:=|$)|--m4(?:=|$))/u.test(argument));
  return false;
};

export const xcrunToolLaunchesHostProcess = (
  requestedName: string,
  canonicalName: string,
  args: readonly string[],
): boolean => {
  if (genericHostDispatch.has(requestedName) || genericHostDispatch.has(canonicalName)) return true;
  if (/^(?:python(?:\d+(?:\.\d+)*)?|pydoc\d*(?:\.\d+)?|pip\d*(?:\.\d+)?|2to3(?:-\d+(?:\.\d+)*)?)$/u.test(requestedName)) return true;
  if (["git-receive-pack", "git-upload-archive", "git-upload-pack", "swift-run"].includes(requestedName)) return true;
  if (requestedName === "leaks") return args.includes("--atExit");
  if (requestedName === "xctrace") return args.includes("--launch");
  return false;
};
