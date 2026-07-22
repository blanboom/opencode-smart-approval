import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks } from "@opencode-ai/plugin";
import { APPROVAL_AGENT_NAME } from "../src/approval-agent";
import {
  APPROVAL_AGENT_TRUSTED_POLICY_CLOSE,
  APPROVAL_AGENT_TRUSTED_POLICY_OPEN,
} from "../src/approval-agent-contract";
import approvalPlugin from "../src/index";
import { fakeClient } from "./fixtures/opencode-client-fake";

const stringField = (value: unknown, key: string): string | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const field = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
};

type TrustedPolicyRegion = {
  readonly closeCount: number;
  readonly openCount: number;
  readonly suffix: string | undefined;
};

const trustedPolicyRegion = (prompt: string | undefined): TrustedPolicyRegion => {
  if (prompt === undefined) return { closeCount: 0, openCount: 0, suffix: undefined };
  const openCount = prompt.split(APPROVAL_AGENT_TRUSTED_POLICY_OPEN).length - 1;
  const closeCount = prompt.split(APPROVAL_AGENT_TRUSTED_POLICY_CLOSE).length - 1;
  const start = prompt.indexOf(APPROVAL_AGENT_TRUSTED_POLICY_OPEN);
  const end = prompt.indexOf(APPROVAL_AGENT_TRUSTED_POLICY_CLOSE);
  const suffix = start < 0 || end <= start
    ? undefined
    : prompt.slice(start + APPROVAL_AGENT_TRUSTED_POLICY_OPEN.length, end).trim();
  return { closeCount, openCount, suffix };
};

describe("policy v3 plugin entry", () => {
  test("loads policy model and prompt before the OpenCode config hook", async () => {
    // Given the real exported plugin entry with an isolated strict v3 policy.
    const root = mkdtempSync(join(tmpdir(), "policy-v3-plugin-entry-"));
    const directory = join(root, "workspace");
    const xdgConfig = join(root, "config");
    const xdgData = join(root, "data");
    const previousConfig = process.env["XDG_CONFIG_HOME"];
    const previousData = process.env["XDG_DATA_HOME"];
    mkdirSync(directory);
    mkdirSync(join(xdgConfig, "opencode"), { recursive: true });
    const suffix = "policy-id:entry-42";
    writeFileSync(join(xdgConfig, "opencode", "command-approval.jsonc"), JSON.stringify({
      version: 3,
      review: { model: "policy-provider/family/reviewer", prompt: suffix },
    }));

    try {
      // When OpenCode applies its config hook with a different small model.
      process.env["XDG_CONFIG_HOME"] = xdgConfig;
      process.env["XDG_DATA_HOME"] = xdgData;
      const hooks = await approvalPlugin.server({
        directory,
        client: fakeClient(async () => ({ data: true })).client,
      });
      const config: Parameters<NonNullable<Hooks["config"]>>[0] = { small_model: "small-provider/model" };
      await hooks.config?.(config);
      const agent = config.agent?.[APPROVAL_AGENT_NAME];

      // Then the actual exported path registers the model and one exact structural suffix region.
      expect(stringField(agent, "model")).toBe("policy-provider/family/reviewer");
      expect(trustedPolicyRegion(stringField(agent, "prompt"))).toEqual({ closeCount: 1, openCount: 1, suffix });
      await hooks.dispose?.();
    } finally {
      if (previousConfig === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = previousConfig;
      if (previousData === undefined) delete process.env["XDG_DATA_HOME"];
      else process.env["XDG_DATA_HOME"] = previousData;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
