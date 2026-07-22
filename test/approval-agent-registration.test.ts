import { describe, expect, test } from "bun:test";
import {
  APPROVAL_AGENT_DESCRIPTION,
  APPROVAL_AGENT_NAME,
  APPROVAL_AGENT_PERMISSION_SUFFIX,
  APPROVAL_AGENT_PROMPT_TOOLS,
  APPROVAL_AGENT_SECURITY_CONTRACT_CLOSE,
  APPROVAL_AGENT_SECURITY_CONTRACT_OPEN,
  APPROVAL_AGENT_TRUSTED_POLICY_CLOSE,
  APPROVAL_AGENT_TRUSTED_POLICY_OPEN,
  ApprovalAgentContractError,
  registerApprovalAgent,
  validateResolvedApprovalAgent,
} from "../src/approval-agent";
import { runtimeApprovalAgent } from "./fixtures/approval-agent-runtime";

describe("fixed approval agent registration", () => {
  test("registers the exact least-privilege agent when OpenCode has a small model", () => {
    // Given: a root OpenCode config with an unrelated agent and a same-name override.
    const config: Record<string, unknown> = {
      small_model: "fixture/reviewer/model",
      agent: {
        existing: { description: "keep" },
        [APPROVAL_AGENT_NAME]: { mode: "primary" },
      },
    };

    // When: the plugin registers its fixed approval agent.
    const registered = registerApprovalAgent(config, "organization-specific guidance");

    // Then: the fixed fields, ordered permissions, structural prompt regions, and model are authoritative.
    expect(registered.description).toBe(APPROVAL_AGENT_DESCRIPTION);
    expect(registered.mode).toBe("subagent");
    expect(registered.steps).toBe(4);
    expect(registered.temperature).toBe(0);
    expect(registered.model).toBe("fixture/reviewer/model");
    expect(Object.keys(registered.permission)).toEqual(["*", "external_directory", "opencode_smart_approval_read"]);
    expect(registered.permission).toEqual({
      "*": "deny",
      external_directory: "deny",
      opencode_smart_approval_read: "allow",
    });
    expect(registered.prompt.startsWith(APPROVAL_AGENT_SECURITY_CONTRACT_OPEN)).toBe(true);
    expect(registered.prompt.indexOf(APPROVAL_AGENT_SECURITY_CONTRACT_CLOSE)).toBeLessThan(
      registered.prompt.indexOf(APPROVAL_AGENT_TRUSTED_POLICY_OPEN),
    );
    expect(registered.prompt.endsWith(APPROVAL_AGENT_TRUSTED_POLICY_CLOSE)).toBe(true);
    expect(config).toEqual({
      small_model: "fixture/reviewer/model",
      agent: {
        existing: { description: "keep" },
        [APPROVAL_AGENT_NAME]: registered,
      },
    });
    expect(APPROVAL_AGENT_PROMPT_TOOLS).toEqual({ "*": false, opencode_smart_approval_read: true });
  });

  test("omits model and trusted policy region instead of forwarding a legacy review model", () => {
    // Given: a root config containing an unrelated legacy v2 review model.
    const config: Record<string, unknown> = {
      agent: {},
      review: { model: "bare-ai-sdk-model" },
    };

    // When: the agent is registered from only the OpenCode root config contract.
    const registered = registerApprovalAgent(config);

    // Then: no model or policy region is authored from the unrelated legacy value.
    expect("model" in registered).toBe(false);
    expect(registered.prompt.includes(APPROVAL_AGENT_TRUSTED_POLICY_OPEN)).toBe(false);
  });

  test("rejects invalid root small_model values at the isolated unknown boundary", () => {
    // Given: a root config value outside ConfigAgentV1's model contract.
    const config: Record<string, unknown> = { small_model: 17 };

    // When/Then: registration rejects it instead of inheriting or coercing the value.
    expect(() => registerApprovalAgent(config)).toThrow(ApprovalAgentContractError);
  });

  test("keeps every exported security authority immutable at runtime", () => {
    // Given: canonical trust roots observed before a fresh-process-style mutation probe.
    const expected = registerApprovalAgent({});
    const originalRules = [...APPROVAL_AGENT_PERMISSION_SUFFIX];
    const originalActions = originalRules.map((rule) => rule.action);
    const frozen = [Object.isFrozen(APPROVAL_AGENT_PERMISSION_SUFFIX), ...originalRules.map((rule) => Object.isFrozen(rule)), Object.isFrozen(APPROVAL_AGENT_PROMPT_TOOLS)];
    let validatorResult = "accepted";
    let configTrust: readonly [string, boolean] = ["missing", false];
    let mutationResults: readonly boolean[] = [];

    // When: public consumers try nested, container, and tool-map writes using non-throwing reflection.
    try {
      mutationResults = originalRules.map((rule, index) => Reflect.set(rule, "action", ["allow", "allow", "deny"][index]));
      try {
        validateResolvedApprovalAgent([runtimeApprovalAgent({
          prompt: expected.prompt,
          permission: [{ permission: "*", pattern: "*", action: "allow" }, { permission: "external_directory", pattern: "*", action: "allow" }, { permission: "opencode_smart_approval_read", pattern: "*", action: "deny" }],
        })], expected);
      } catch (error) {
        validatorResult = error instanceof ApprovalAgentContractError ? error.code : "unexpected_error";
      }
      const registeredAfterMutation = registerApprovalAgent({});
      configTrust = [registeredAfterMutation.permission["*"], registeredAfterMutation.prompt === expected.prompt];
      mutationResults = [...mutationResults,
        Reflect.set(APPROVAL_AGENT_PERMISSION_SUFFIX, "0", { ...originalRules[0] }),
        Reflect.set(APPROVAL_AGENT_PERMISSION_SUFFIX, "3", { ...originalRules[0] }),
        Reflect.set(APPROVAL_AGENT_PROMPT_TOOLS, "*", true),
        Reflect.set(APPROVAL_AGENT_PROMPT_TOOLS, "opencode_smart_approval_read", false)];
    } finally {
      Reflect.set(APPROVAL_AGENT_PERMISSION_SUFFIX, "0", originalRules[0]);
      Reflect.deleteProperty(APPROVAL_AGENT_PERMISSION_SUFFIX, "3");
      Reflect.set(APPROVAL_AGENT_PERMISSION_SUFFIX, "length", 3);
      originalRules.forEach((rule, index) => Reflect.set(rule, "action", originalActions[index]));
      Reflect.set(APPROVAL_AGENT_PROMPT_TOOLS, "*", false);
      Reflect.set(APPROVAL_AGENT_PROMPT_TOOLS, "opencode_smart_approval_read", true);
    }

    // Then: all writes fail, the unsafe wildcard allow is rejected, and both exports remain canonical.
    expect(frozen).toEqual([true, true, true, true, true]);
    expect(mutationResults).toEqual([false, false, false, false, false, false, false]);
    expect(validatorResult).toBe("permission_suffix_mismatch");
    expect(configTrust).toEqual(["deny", true]);
    expect(APPROVAL_AGENT_PERMISSION_SUFFIX).toEqual([
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "opencode_smart_approval_read", pattern: "*", action: "allow" },
    ]);
    expect(APPROVAL_AGENT_PROMPT_TOOLS).toEqual({ "*": false, opencode_smart_approval_read: true });
  });
});
