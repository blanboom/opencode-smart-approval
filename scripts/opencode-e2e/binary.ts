import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { HarnessContractError } from "./errors";

export const REQUIRED_ENVIRONMENT_KEYS = [
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_DB",
  "OPENCODE_AUTH_CONTENT",
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_DISABLE_SHARE",
  "OPENCODE_AUTO_SHARE",
  "OPENCODE_DISABLE_MODELS_FETCH",
  "OPENCODE_DISABLE_LSP_DOWNLOAD",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_EXTERNAL_SKILLS",
  "OPENCODE_DISABLE_EMBEDDED_WEB_UI",
  "OPENCODE_DISABLE_PRUNE",
  "OPENCODE_ENABLE_EXA",
  "OPENCODE_ENABLE_QUESTION_TOOL",
  "OPENCODE_DISABLE_DEFAULT_PLUGINS",
  "OPENCODE_PURE",
] as const;

export type BinaryReceipt = {
  readonly executable: string;
  readonly executableSha256: string;
  readonly platformSha256: string;
  readonly wrapper: {
    readonly name: string;
    readonly version: string;
    readonly rawBin: string;
    readonly canonicalBin: string;
  };
  readonly platform: { readonly name: string; readonly version: string };
  readonly environmentKeys: readonly string[];
};

const WRAPPER_INTEGRITY = "sha512-UuWFOBtiYufHsvHtnn2/AASjDM8wW+kSkDnvAG2cbfSsIXU3wGG9nS9XSKvLelvZBigTi5DkqFl8Z0YKxMDifg==";
const PLATFORM_INTEGRITY = "sha512-UGD7xl4E2rwdjrq+mLjoQK15T0179Iu3LeaCU+kYgprcFtLA9DRbB0nwgbXMaY/n78mlG1tAIrkyWyf2Pi6a9g==";
const WrapperSchema = z.object({
  name: z.literal("opencode-ai"),
  version: z.literal("1.17.14"),
  bin: z.object({ opencode: z.literal("./bin/opencode.exe") }).strict(),
}).passthrough();
const PlatformSchema = z.object({
  name: z.literal("opencode-darwin-arm64"),
  version: z.literal("1.17.14"),
}).passthrough();

const sha256 = (path: string): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(readFileSync(path));
  return hasher.digest("hex");
};

const runExact = (command: readonly string[]): string => {
  const result = Bun.spawnSync({
    cmd: [...command],
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TMPDIR: "/tmp" },
    maxBuffer: 64 * 1_024 * 1_024,
  });
  if (result.exitCode !== 0 || result.stderr.byteLength !== 0) throw new HarnessContractError("binary_contract");
  return new TextDecoder().decode(result.stdout);
};

export const requireBinaryLockReceipts = (lock: string): void => {
  if (!lock.includes(WRAPPER_INTEGRITY) || !lock.includes(PLATFORM_INTEGRITY)) {
    throw new HarnessContractError("binary_contract");
  }
};

export const inspectLocalOpenCodeBinary = (packageRoot: string): BinaryReceipt => {
  if (!isAbsolute(packageRoot) || process.platform !== "darwin" || process.arch !== "arm64") {
    throw new HarnessContractError("binary_contract");
  }
  const executable = runExact(["/bin/realpath", join(packageRoot, "node_modules", ".bin", "opencode")]).trim();
  const expectedExecutable = join(packageRoot, "node_modules", "opencode-ai", "bin", "opencode.exe");
  if (executable !== expectedExecutable) throw new HarnessContractError("binary_contract");
  const wrapper = WrapperSchema.safeParse(JSON.parse(readFileSync(join(packageRoot, "node_modules", "opencode-ai", "package.json"), "utf8")));
  const platform = PlatformSchema.safeParse(JSON.parse(readFileSync(join(packageRoot, "node_modules", "opencode-darwin-arm64", "package.json"), "utf8")));
  if (!wrapper.success || !platform.success) throw new HarnessContractError("binary_contract");
  requireBinaryLockReceipts(readFileSync(join(packageRoot, "bun.lock"), "utf8"));
  const platformExecutable = join(packageRoot, "node_modules", "opencode-darwin-arm64", "bin", "opencode");
  const executableSha256 = sha256(executable);
  const platformSha256 = sha256(platformExecutable);
  if (executableSha256 !== platformSha256) throw new HarnessContractError("binary_contract");
  const strings = runExact(["/usr/bin/strings", executable]);
  if (REQUIRED_ENVIRONMENT_KEYS.some((key) => !strings.includes(key))) throw new HarnessContractError("binary_contract");
  return Object.freeze({
    executable,
    executableSha256,
    platformSha256,
    wrapper: Object.freeze({
      name: wrapper.data.name,
      version: wrapper.data.version,
      rawBin: wrapper.data.bin.opencode,
      canonicalBin: wrapper.data.bin.opencode.replace(/^\.\//u, ""),
    }),
    platform: Object.freeze({ name: platform.data.name, version: platform.data.version }),
    environmentKeys: Object.freeze([...REQUIRED_ENVIRONMENT_KEYS]),
  });
};
