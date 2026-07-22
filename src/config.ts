import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultConfigJson, defaultPolicy } from "./default-config";
import { parsePolicyJsonc, policyDocumentFromUnknown, stripJsonComments } from "./policy-parser";
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
  | {
      readonly ok: true;
      readonly policy: ResolvedPolicy;
      readonly path: string;
      readonly effectivePolicyPaths: readonly string[];
      readonly initialized: boolean;
    }
  | {
      readonly ok: false;
      readonly policy: ResolvedPolicy;
      readonly path: string;
      readonly effectivePolicyPaths: readonly string[];
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
  if (existsSync(gLegacy)) {
    return {
      ok: false,
      data: undefined,
      error: "legacy policy filename is not supported",
      path: gLegacy,
      initialized: false,
    };
  }
  return initGlobalFile();
};

const resolveLocal = (directory: string): LoadOutcome | undefined => {
  const lPath = localPolicyPath(directory);
  const lLegacy = legacyLocalPolicyPath(directory);
  if (existsSync(lPath)) return loadFromFile(lPath, false);
  if (existsSync(lLegacy)) {
    return {
      ok: false,
      data: undefined,
      error: "legacy policy filename is not supported",
      path: lLegacy,
      initialized: false,
    };
  }
  return undefined;
};

export const loadOrInitializePolicy = (directory: string): PolicyLoadResult => {
  const fallbackRules = defaultPolicy().rules;
  const effectiveGlobalPath = globalPolicyPath();
  const globalEffectivePaths = [effectiveGlobalPath] as const;

  const global = resolveGlobal();
  if (!global.ok) {
    return {
      ok: false,
      policy: defaultPolicy(),
      path: global.path,
      effectivePolicyPaths: globalEffectivePaths,
      initialized: global.initialized,
      error: global.error ?? "global policy load failed",
    };
  }

  let trustedGlobal: { readonly policy: ResolvedPolicy; readonly allowLocalConfig: boolean };
  try {
    trustedGlobal = policyDocumentFromUnknown(global.data, fallbackRules);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown policy load failure";
    return {
      ok: false,
      policy: defaultPolicy(),
      path: global.path,
      effectivePolicyPaths: globalEffectivePaths,
      initialized: global.initialized,
      error: message,
    };
  }

  if (!trustedGlobal.allowLocalConfig) {
    return {
      ok: true,
      policy: trustedGlobal.policy,
      path: global.path,
      effectivePolicyPaths: globalEffectivePaths,
      initialized: global.initialized,
    };
  }

  const localEffectivePaths = [effectiveGlobalPath, localPolicyPath(directory)] as const;
  const local = resolveLocal(directory);
  if (!local) {
    return {
      ok: true,
      policy: trustedGlobal.policy,
      path: global.path,
      effectivePolicyPaths: localEffectivePaths,
      initialized: global.initialized,
    };
  }
  if (!local.ok) {
    return {
      ok: false,
      policy: defaultPolicy(),
      path: local.path,
      effectivePolicyPaths: localEffectivePaths,
      initialized: false,
      error: local.error ?? "local policy load failed",
    };
  }
  try {
    const resolved = policyDocumentFromUnknown(local.data, fallbackRules);
    return { ok: true, policy: resolved.policy, path: local.path, effectivePolicyPaths: localEffectivePaths, initialized: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown policy load failure";
    return {
      ok: false,
      policy: defaultPolicy(),
      path: local.path,
      effectivePolicyPaths: localEffectivePaths,
      initialized: false,
      error: message,
    };
  }
};
