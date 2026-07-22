import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { HarnessContractError } from "./errors";

export type DependencySeedReceipt = {
  readonly name: "@opencode-ai/plugin";
  readonly version: "1.17.14";
  readonly integrity: string;
};

const PLUGIN_INTEGRITY = "sha512-upKf4QHZqjr2cqHJcJiGTUSGJFFVR26Nu8Y2QRThQ2NgXcQ44T1cRvI80nhK87wQsFcHPI842d+cPYERV+lB4w==";
const PluginPackageSchema = z.object({
  name: z.literal("@opencode-ai/plugin"),
  version: z.literal("1.17.14"),
}).passthrough();

export const seedIsolatedPluginDependency = (
  packageRoot: string,
  configDirectory: string,
): DependencySeedReceipt => {
  if (!isAbsolute(packageRoot) || !isAbsolute(configDirectory)) throw new HarnessContractError("binary_contract");
  const source = join(packageRoot, "node_modules", "@opencode-ai", "plugin");
  try {
    const parsed = PluginPackageSchema.safeParse(JSON.parse(readFileSync(join(source, "package.json"), "utf8")));
    const lock = readFileSync(join(packageRoot, "bun.lock"), "utf8");
    if (!parsed.success || !lock.includes(PLUGIN_INTEGRITY)) throw new HarnessContractError("binary_contract");
    const destination = join(configDirectory, "node_modules", "@opencode-ai", "plugin");
    mkdirSync(join(configDirectory, "node_modules", "@opencode-ai"), { recursive: true });
    cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
    const rootDependency = { "@opencode-ai/plugin": "1.17.14" } as const;
    writeFileSync(join(configDirectory, "package.json"), `${JSON.stringify({ private: true, dependencies: rootDependency }, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(configDirectory, "package-lock.json"), `${JSON.stringify({
      name: "opencode-smart-approval-e2e-config",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { dependencies: rootDependency },
        "node_modules/@opencode-ai/plugin": {
          version: "1.17.14",
          integrity: PLUGIN_INTEGRITY,
        },
      },
    }, null, 2)}\n`, { mode: 0o600 });
    return Object.freeze({ name: parsed.data.name, version: parsed.data.version, integrity: PLUGIN_INTEGRITY });
  } catch (error) {
    if (error instanceof HarnessContractError) throw error;
    throw new HarnessContractError("binary_contract");
  }
};
