import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POLICY_FILE_NAME } from "../src/config";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

export const tempDir = (): string => {
  return mkdtempSync(join(tmpdir(), "command-approval-test-"));
};

export const xdgConfigHome = (): string => {
  const value = process.env["XDG_CONFIG_HOME"];
  if (!value) throw new Error("XDG_CONFIG_HOME is not set");
  return value;
};

export const withXdg = <T>(fn: () => T): T => {
  const saved = process.env["XDG_CONFIG_HOME"];
  const xdg = mkdtempSync(join(tmpdir(), "xdg-config-"));
  process.env["XDG_CONFIG_HOME"] = xdg;
  mkdirSync(join(xdg, "opencode"), { recursive: true });
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = saved;
    rmSync(xdg, { recursive: true, force: true });
  }
};

export const reviewFixture = (overrides: JsonObject = {}): JsonObject => ({
  model: "test-provider/test-model",
  timeout_ms: 45_000,
  ...overrides,
});

export const policyFixture = (review: JsonObject = reviewFixture()): JsonObject => ({
  version: 3,
  review,
  rules: { deny: [], review: [], allow: [] },
});

const completePolicy = (policy: JsonObject): JsonObject => ({ version: 3, review: {}, ...policy });

export const writeLocalPolicy = (directory: string, policy: JsonObject | string): void => {
  writeFileSync(
    join(directory, POLICY_FILE_NAME),
    typeof policy === "string" ? policy : JSON.stringify(completePolicy(policy)),
  );
};

export const writeGlobalPolicy = (policy: JsonObject | string): void => {
  writeFileSync(
    join(xdgConfigHome(), "opencode", POLICY_FILE_NAME),
    typeof policy === "string" ? policy : JSON.stringify(completePolicy(policy)),
  );
};
