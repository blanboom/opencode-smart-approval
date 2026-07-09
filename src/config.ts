import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultConfigJson, defaultPolicy } from "./default-config";
import { parsePolicyJsonc, policyFromUnknown, stripJsonComments } from "./policy-parser";
import type { ResolvedPolicy } from "./types";

export { stripJsonComments };

export const POLICY_FILE_NAME = "command-approval.jsonc";
const LEGACY_POLICY_FILE_NAME = "command-approval.json";

const globalConfigDir = (): string => {
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg && xdg.length > 0) return join(xdg, "opencode");
  return join(homedir(), ".config", "opencode");
};

const globalPolicyPath = (): string => join(globalConfigDir(), POLICY_FILE_NAME);
const legacyGlobalPolicyPath = (): string => join(globalConfigDir(), LEGACY_POLICY_FILE_NAME);

const localPolicyPath = (directory: string): string => join(directory, POLICY_FILE_NAME);
const legacyLocalPolicyPath = (directory: string): string => join(directory, LEGACY_POLICY_FILE_NAME);


export type PolicyLoadResult =
  | { readonly ok: true; readonly policy: ResolvedPolicy; readonly path: string; readonly initialized: boolean }
  | {
      readonly ok: false;
      readonly policy: ResolvedPolicy;
      readonly path: string;
      readonly initialized: boolean;
      readonly error: string;
    };

type LoadOutcome = {
  readonly ok: boolean;
  readonly data: unknown | undefined;
  readonly error: string | undefined;
  readonly path: string;
  readonly initialized: boolean;
};

const loadFromFile = (path: string, initialized: boolean): LoadOutcome => {
  try {
    const data = parsePolicyJsonc(readFileSync(path, "utf8"));
    return { ok: true, data, error: undefined, path, initialized };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown policy load failure";
    return { ok: false, data: undefined, error: message, path, initialized };
  }
};

const initGlobalFile = (): LoadOutcome => {
  const dir = globalConfigDir();
  const path = globalPolicyPath();
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(path)) {
      writeFileSync(path, defaultConfigJson(), { encoding: "utf8", mode: 0o600 });
    }
    return loadFromFile(path, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown policy init failure";
    return { ok: false, data: undefined, error: message, path, initialized: false };
  }
};

const resolveGlobal = (): LoadOutcome => {
  const gPath = globalPolicyPath();
  const gLegacy = legacyGlobalPolicyPath();
  if (existsSync(gPath)) return loadFromFile(gPath, false);
  if (existsSync(gLegacy)) return loadFromFile(gLegacy, false);
  return initGlobalFile();
};

const resolveLocal = (directory: string): LoadOutcome | undefined => {
  const lPath = localPolicyPath(directory);
  const lLegacy = legacyLocalPolicyPath(directory);
  if (existsSync(lPath)) return loadFromFile(lPath, false);
  if (existsSync(lLegacy)) return loadFromFile(lLegacy, false);
  return undefined;
};

export const loadOrInitializePolicy = (directory: string): PolicyLoadResult => {
  const fallbackRules = defaultPolicy().rules;

  // Local config takes priority if it exists.
  const local = resolveLocal(directory);
  if (local) {
    if (!local.ok) {
      return {
        ok: false,
        policy: defaultPolicy(),
        path: local.path,
        initialized: false,
        error: local.error ?? "local policy load failed",
      };
    }
    try {
      const policy = policyFromUnknown(local.data, fallbackRules);
      return { ok: true, policy, path: local.path, initialized: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown policy load failure";
      return { ok: false, policy: defaultPolicy(), path: local.path, initialized: false, error: message };
    }
  }

  // Fall back to global config, initializing if missing.
  const global = resolveGlobal();
  if (!global.ok) {
    return {
      ok: false,
      policy: defaultPolicy(),
      path: global.path,
      initialized: global.initialized,
      error: global.error ?? "global policy load failed",
    };
  }

  try {
    const policy = policyFromUnknown(global.data, fallbackRules);
    return { ok: true, policy, path: global.path, initialized: global.initialized };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown policy load failure";
    return { ok: false, policy: defaultPolicy(), path: global.path, initialized: global.initialized, error: message };
  }
};
