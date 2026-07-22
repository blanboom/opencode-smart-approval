import { HarnessContractError } from "./opencode-e2e/errors";
import { z } from "zod";

export type PackReceipt = {
  readonly filename: string;
  readonly files: readonly string[];
};

export type ExtractedPackageReceipt = {
  readonly version: string;
  readonly fileCount: number;
};

const PackageScriptsSchema = z.object({ scripts: z.record(z.string(), z.string()).optional() }).passthrough();
const PackReceiptSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  version: z.string().optional(),
  size: z.number().nonnegative().optional(),
  unpackedSize: z.number().nonnegative().optional(),
  shasum: z.string().optional(),
  integrity: z.string().optional(),
  filename: z.string().min(1),
  files: z.array(z.object({
    path: z.string().min(1),
    size: z.number().nonnegative().optional(),
    mode: z.number().int().nonnegative().optional(),
  }).strict()).max(2_000),
  entryCount: z.number().int().nonnegative().optional(),
  bundled: z.array(z.string()).optional(),
}).strict();
const PublicPackageSchema = z.object({
  name: z.literal("opencode-smart-approval"),
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u),
  description: z.literal("OpenCode command approval plugin with deterministic rules, Tirith scanning, and a restricted direct OpenCode approval agent."),
  type: z.literal("module"),
  main: z.literal("src/index.ts"),
  exports: z.object({ ".": z.literal("./src/index.ts") }).strict(),
  files: z.tuple([
    z.literal("src"),
    z.literal("assets"),
    z.literal("README.md"),
    z.literal("README.zh-CN.md"),
    z.literal("LICENSE"),
  ]),
  dependencies: z.object({
    "@opencode-ai/plugin": z.literal("1.17.14"),
    "web-tree-sitter": z.literal("0.26.11"),
    zod: z.literal("4.1.13"),
  }).strict(),
}).passthrough();

const forbiddenLifecycleScripts = new Set([
  "prepack", "prepare", "pack", "postpack", "prepublish", "prepublishOnly", "publish", "postpublish",
  "preinstall", "install", "postinstall",
]);

export const requireLifecycleSafePackage = (input: unknown): void => {
  const parsed = PackageScriptsSchema.safeParse(input);
  if (!parsed.success) throw new HarnessContractError("package_contract");
  if (Object.keys(parsed.data.scripts ?? {}).some((script) => forbiddenLifecycleScripts.has(script))) {
    throw new HarnessContractError("package_contract");
  }
};

export const parsePackReceipts = (input: unknown): readonly PackReceipt[] => {
  const parsed = z.array(PackReceiptSchema).length(1).safeParse(input);
  if (!parsed.success) throw new HarnessContractError("package_contract");
  return Object.freeze(parsed.data.map((receipt) => Object.freeze({
    filename: receipt.filename,
    files: Object.freeze(receipt.files.map((file) => file.path)),
  })));
};

const sortedUnique = (input: readonly string[]): readonly string[] => {
  if (new Set(input).size !== input.length) throw new HarnessContractError("package_contract");
  return Object.freeze([...input].sort());
};

const isPublicPackagePath = (path: string): boolean => (
  path === "package.json" ||
  path === "README.md" ||
  path === "README.zh-CN.md" ||
  path === "LICENSE" ||
  path.startsWith("src/") ||
  path.startsWith("assets/")
);

export const requireExtractedPackageContract = (
  sourceInput: unknown,
  extractedInput: unknown,
  receiptFilesInput: readonly string[],
  extractedFilesInput: readonly string[],
): ExtractedPackageReceipt => {
  const source = PublicPackageSchema.safeParse(sourceInput);
  const extracted = PublicPackageSchema.safeParse(extractedInput);
  if (!source.success || !extracted.success || source.data.version !== extracted.data.version) {
    throw new HarnessContractError("package_contract");
  }
  requireLifecycleSafePackage(sourceInput);
  requireLifecycleSafePackage(extractedInput);
  const receiptFiles = sortedUnique(receiptFilesInput);
  const extractedFiles = sortedUnique(extractedFilesInput);
  if (
    receiptFiles.length === 0 ||
    receiptFiles.some((path) => !isPublicPackagePath(path)) ||
    receiptFiles.some((path, index) => path !== extractedFiles[index]) ||
    receiptFiles.length !== extractedFiles.length ||
    !receiptFiles.includes("package.json") ||
    !receiptFiles.includes("src/index.ts")
  ) {
    throw new HarnessContractError("package_contract");
  }
  return Object.freeze({ version: source.data.version, fileCount: extractedFiles.length });
};
