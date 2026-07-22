import { describe, expect, test } from "bun:test";
import { createApprovalPluginIntegration } from "../src/approval-plugin-integration";
import {
  APPROVAL_AGENT_TRUSTED_POLICY_CLOSE,
  APPROVAL_AGENT_TRUSTED_POLICY_OPEN,
} from "../src/approval-agent-contract";
import { defaultPolicy } from "../src/default-config";
import type { ReviewConfig } from "../src/types";
import { FakeAnchoredFsAdapter } from "./fixtures/fake-anchored-fs";

const integrationFor = (reviewConfig: ReviewConfig) => {
  const adapter = new FakeAnchoredFsAdapter();
  adapter.addDirectory("/workspace");
  adapter.addDirectory("/tmp");
  return createApprovalPluginIntegration(
    { directory: "/workspace", worktree: "/workspace" },
    {
      adapter,
      environment: { XDG_DATA_HOME: "/isolated/data" },
      homeDirectory: "/unused-home",
      tempDirectory: "/tmp",
      reviewConfig,
      createToolExecuteBefore: () => async () => undefined,
    },
  );
};

const configure = async (reviewConfig: ReviewConfig, smallModel?: string) => {
  const integration = integrationFor(reviewConfig);
  const hook = integration.hooks.config;
  if (!hook) throw new TypeError("missing config hook");
  await hook(smallModel === undefined ? {} : { small_model: smallModel });
  return integration;
};

const tokenCount = (value: string, token: string): number => value.split(token).length - 1;

describe("policy v3 approval agent options", () => {
  test("gives validated policy model precedence over OpenCode small_model", async () => {
    // Given both a v3 policy model and an OpenCode small_model.
    const integration = await configure(
      { ...defaultPolicy().review, model: "policy-provider/family/reviewer" },
      "small-provider/small-model",
    );

    // When the fixed approval agent is registered.
    const expected = integration.expectedAgent();

    // Then the policy model is the exact immutable expectation.
    expect(expected?.config.model).toBe("policy-provider/family/reviewer");
    await integration.hooks.dispose?.();
  });

  test("falls back to OpenCode small_model only when policy model is absent", async () => {
    // Given an absent policy model and a valid OpenCode small_model.
    const integration = await configure(defaultPolicy().review, "small-provider/small-model");

    // When the fixed approval agent is registered.
    const expected = integration.expectedAgent();

    // Then the small model is selected.
    expect(expected?.config.model).toBe("small-provider/small-model");
    await integration.hooks.dispose?.();
  });

  test("omits the agent model when both policy and OpenCode models are absent", async () => {
    // Given neither model source.
    const integration = await configure(defaultPolicy().review);

    // When the fixed approval agent is registered.
    const expected = integration.expectedAgent();

    // Then OpenCode inherits its configured selection.
    expect(Object.hasOwn(expected?.config ?? {}, "model")).toBe(false);
    await integration.hooks.dispose?.();
  });

  test("uses only a present trusted policy prompt as the agent suffix", async () => {
    // Given an opaque trusted policy identity in v3 policy.
    const suffix = "policy-id:organization-42";
    const integration = await configure({ ...defaultPolicy().review, prompt: suffix });

    // When the fixed approval-agent expectation is registered.
    const expected = integration.expectedAgent();
    const prompt = expected?.config.prompt ?? "";
    const openIndex = prompt.indexOf(APPROVAL_AGENT_TRUSTED_POLICY_OPEN);
    const closeIndex = prompt.indexOf(APPROVAL_AGENT_TRUSTED_POLICY_CLOSE);

    // Then the typed route and the single ordered structural region preserve its identity.
    expect(expected?.trustedPolicy).toEqual({ kind: "present", suffix });
    expect(tokenCount(prompt, APPROVAL_AGENT_TRUSTED_POLICY_OPEN)).toBe(1);
    expect(tokenCount(prompt, APPROVAL_AGENT_TRUSTED_POLICY_CLOSE)).toBe(1);
    expect(openIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeGreaterThan(openIndex);
    expect(prompt.slice(openIndex + APPROVAL_AGENT_TRUSTED_POLICY_OPEN.length, closeIndex)).toBe(`\n\n${suffix}\n\n`);
    await integration.hooks.dispose?.();
  });

  test("keeps the invariant agent prompt unchanged when policy prompt is absent", async () => {
    // Given no trusted policy suffix.
    const integration = await configure(defaultPolicy().review);

    // When the fixed approval-agent expectation is registered.
    const expected = integration.expectedAgent();
    const prompt = expected?.config.prompt ?? "";

    // Then the typed route is absent and no trusted-policy region is authored.
    expect(expected?.trustedPolicy).toEqual({ kind: "absent" });
    expect(tokenCount(prompt, APPROVAL_AGENT_TRUSTED_POLICY_OPEN)).toBe(0);
    expect(tokenCount(prompt, APPROVAL_AGENT_TRUSTED_POLICY_CLOSE)).toBe(0);
    await integration.hooks.dispose?.();
  });
});
