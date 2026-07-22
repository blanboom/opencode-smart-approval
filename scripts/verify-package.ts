import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  parsePackReceipts,
  requireExtractedPackageContract,
  requireLifecycleSafePackage,
  type PackReceipt,
} from "./package-contract";
import { HarnessContractError } from "./opencode-e2e/errors";

const packageRoot = join(import.meta.dir, "..");
const decoder = new TextDecoder();

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

const requireExecutable = (name: string): string => {
  const path = Bun.which(name);
  if (path === null || !path.startsWith("/")) throw new HarnessContractError("package_contract");
  return path;
};

const run = (
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
): string => {
  const result = Bun.spawnSync({
    cmd: [...command],
    cwd,
    env: { ...environment },
    stdout: "pipe",
    stderr: "pipe",
    maxBuffer: 8 * 1_024 * 1_024,
  });
  if (result.exitCode !== 0) {
    process.stderr.write(decoder.decode(result.stderr).slice(0, 65_536));
    throw new HarnessContractError("package_contract");
  }
  return decoder.decode(result.stdout);
};

const pack = (
  npm: string,
  destination: string,
  environment: Readonly<Record<string, string>>,
  dryRun: boolean,
): PackReceipt => {
  const command = [
    npm,
    "pack",
    ...(dryRun ? ["--dry-run"] : []),
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    destination,
  ];
  let parsed: unknown;
  try {
    parsed = JSON.parse(run(command, packageRoot, environment));
  } catch (error) {
    if (error instanceof HarnessContractError) throw error;
    throw new HarnessContractError("package_contract");
  }
  const receipt = parsePackReceipts(parsed)[0];
  if (receipt === undefined || basename(receipt.filename) !== receipt.filename) {
    throw new HarnessContractError("package_contract");
  }
  return receipt;
};

const extractedFiles = async (root: string): Promise<readonly string[]> => {
  const files: string[] = [];
  for await (const path of new Bun.Glob("**/*").scan({ cwd: root, dot: true, onlyFiles: true })) {
    if (lstatSync(join(root, path)).isSymbolicLink()) throw new HarnessContractError("package_contract");
    files.push(path);
  }
  return Object.freeze(files.sort());
};

const main = async (): Promise<void> => {
  const sourcePackage = readJson(join(packageRoot, "package.json"));
  requireLifecycleSafePackage(sourcePackage);
  const root = mkdtempSync("/private/tmp/opencode-smart-approval-pack-");
  try {
    const npm = requireExecutable("npm");
    const node = requireExecutable("node");
    const environment = Object.freeze({
      PATH: `${dirname(npm)}:${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      HOME: root,
      TMPDIR: root,
      npm_config_cache: join(root, "npm-cache"),
      npm_config_userconfig: join(root, "empty-npmrc"),
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_ignore_scripts: "true",
    });
    const dryRun = pack(npm, root, environment, true);
    const actual = pack(npm, root, environment, false);
    if (
      dryRun.filename !== actual.filename ||
      dryRun.files.length !== actual.files.length ||
      dryRun.files.some((path, index) => path !== actual.files[index])
    ) throw new HarnessContractError("package_contract");
    const tarball = join(root, actual.filename);
    const tarResult = Bun.spawnSync({
      cmd: ["/usr/bin/tar", "-xzf", tarball, "-C", root],
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TMPDIR: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (tarResult.exitCode !== 0 || tarResult.stdout.byteLength !== 0 || tarResult.stderr.byteLength !== 0) {
      throw new HarnessContractError("package_contract");
    }
    const extractedRoot = join(root, "package");
    const files = await extractedFiles(extractedRoot);
    const receipt = requireExtractedPackageContract(
      sourcePackage,
      readJson(join(extractedRoot, "package.json")),
      actual.files,
      files,
    );
    process.stdout.write(`${JSON.stringify({
      ok: true,
      commands: [
        "npm pack --dry-run --ignore-scripts --json",
        "npm pack --ignore-scripts --json",
      ],
      ...receipt,
      filename: actual.filename,
      rootRemovedInFinally: true,
    })}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

await main();
