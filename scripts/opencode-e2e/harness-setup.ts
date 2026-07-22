import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HarnessContractError } from "./errors";
import type { HarnessDirectories } from "./environment";

export const directoriesFor = (root: string): HarnessDirectories => ({
  root,
  home: join(root, "home"),
  config: join(root, "config"),
  data: join(root, "data"),
  cache: join(root, "cache"),
  state: join(root, "state"),
  tmp: join(root, "tmp"),
  workspace: join(root, "workspace"),
  database: join(root, "database", "opencode.sqlite"),
});

export const createHarnessDirectories = (directories: HarnessDirectories): void => {
  for (const path of [
    directories.home,
    directories.config,
    directories.data,
    directories.cache,
    directories.state,
    directories.tmp,
    directories.workspace,
    join(directories.root, "database"),
  ]) mkdirSync(path, { recursive: true });
};

export const reserveClosedPort = async (): Promise<number> => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) });
  const port = server.port;
  await server.stop(true);
  if (port === undefined || !Number.isSafeInteger(port) || port < 1) throw new HarnessContractError("environment");
  return port;
};

export const requireOpenCodeVersion = (
  executable: string,
  environment: Readonly<Record<string, string>>,
): string => {
  const result = Bun.spawnSync({ cmd: [executable, "--version"], env: { ...environment }, stdout: "pipe", stderr: "pipe" });
  const stdout = new TextDecoder().decode(result.stdout);
  if (result.exitCode !== 0 || stdout !== "1.17.14\n" || result.stderr.byteLength !== 0) {
    throw new HarnessContractError("binary_contract");
  }
  return stdout.trim();
};
