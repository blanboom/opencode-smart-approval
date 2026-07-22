import { describe, expect, test } from "bun:test";
import {
  APPROVAL_AGENT_NAME,
  APPROVAL_AGENT_PERMISSION_SUFFIX,
  ApprovalAgentContractError,
  registerApprovalAgent,
  validateResolvedApprovalAgent,
} from "../src/approval-agent";
import { runtimeApprovalAgent } from "./fixtures/approval-agent-runtime";

describe("fixed approval agent runtime validation", () => {
  test("validates the source-runtime fields and normalized model", () => {
    // Given: the authored config and a source-shaped runtime agent list.
    const config: Record<string, unknown> = { small_model: "fixture/reviewer/model" };
    const registered = registerApprovalAgent(config);
    const resolved = runtimeApprovalAgent({
      prompt: registered.prompt,
      ...(registered.model !== undefined ? { model: registered.model } : {}),
    });

    // When: the unknown app.agents payload is checked.
    const validated = validateResolvedApprovalAgent([resolved], registered);

    // Then: the strict runtime result is returned with steps and normalized permissions.
    expect(validated.name).toBe(resolved.name);
    expect(validated.prompt).toBe(resolved.prompt);
    expect(validated.steps).toBe(4);
    expect([...validated.permission.slice(-3)]).toEqual([...APPROVAL_AGENT_PERMISSION_SUFFIX]);
    expect("maxSteps" in validated).toBe(false);
    expect("tools" in validated).toBe(false);
  });

  test.each([
    ["description", { description: "mutated" }],
    ["prompt", { prompt: "mutated" }],
    ["mode", { mode: "primary" }],
    ["steps", { steps: 5 }],
    ["temperature", { temperature: 0.5 }],
    ["native identity", { native: true }],
    ["hidden state", { hidden: true }],
    ["options", { options: { unsafe: true } }],
    ["normalized model", { model: { providerID: "fixture", modelID: "other" } }],
  ] as const)("rejects a later runtime %s override", (_label, override) => {
    // Given: a source-valid resolved agent changed after this plugin's config hook.
    const config: Record<string, unknown> = { small_model: "fixture/reviewer/model" };
    const registered = registerApprovalAgent(config);
    const resolved = {
      ...runtimeApprovalAgent({ prompt: registered.prompt, model: "fixture/reviewer/model" }),
      ...override,
    };

    // When/Then: exact runtime identity validation fails closed.
    expect(() => validateResolvedApprovalAgent([resolved], registered)).toThrow(ApprovalAgentContractError);
  });

  test("rejects a runtime prompt copied from a later mutation of the shared registered agent", () => {
    // Given: the returned trusted expectation and the independently shared config agent.
    const config: {
      readonly small_model: string;
      readonly agent: Record<string, { prompt?: string; model?: string }>;
    } = { small_model: "fixture/reviewer/model", agent: {} };
    const expected = registerApprovalAgent(config);
    const shared = config.agent[APPROVAL_AGENT_NAME];
    if (!shared) throw new ApprovalAgentContractError("invalid_config");
    shared.prompt = "later hook prompt";

    // When/Then: matching the malicious runtime prompt cannot poison the trusted comparison value.
    expect(() => validateResolvedApprovalAgent([
      runtimeApprovalAgent({ prompt: "later hook prompt", model: "fixture/reviewer/model" }),
    ], expected)).toThrow(ApprovalAgentContractError);
  });

  test("rejects a runtime model copied from a later mutation of the shared registered agent", () => {
    // Given: the returned trusted expectation and a later hook changing only the shared model.
    const config: {
      readonly small_model: string;
      readonly agent: Record<string, { prompt?: string; model?: string }>;
    } = { small_model: "fixture/reviewer/model", agent: {} };
    const expected = registerApprovalAgent(config);
    const shared = config.agent[APPROVAL_AGENT_NAME];
    if (!shared) throw new ApprovalAgentContractError("invalid_config");
    shared.model = "fixture/later/model";

    // When/Then: matching the malicious runtime model cannot replace the original small_model expectation.
    expect(() => validateResolvedApprovalAgent([
      runtimeApprovalAgent({ prompt: expected.prompt, model: "fixture/later/model" }),
    ], expected)).toThrow(ApprovalAgentContractError);
  });

  test.each([
    ["later allow", [{ permission: "bash", pattern: "*", action: "allow" }]],
    ["changed suffix", [{ permission: "opencode_smart_approval_read", pattern: "*", action: "deny" }]],
  ] as const)("rejects %s after the owned permission suffix", (_label, appended) => {
    // Given: a later hook changed the runtime permission tail.
    const config: Record<string, unknown> = {};
    const registered = registerApprovalAgent(config);
    const permission = [
      { permission: "read", pattern: "*", action: "allow" as const },
      ...APPROVAL_AGENT_PERMISSION_SUFFIX,
      ...appended,
    ];

    // When/Then: the final runtime contract fails closed.
    expect(() => validateResolvedApprovalAgent(
      [runtimeApprovalAgent({ prompt: registered.prompt, permission })],
      registered,
    )).toThrow(ApprovalAgentContractError);
  });

  test("accepts an identical earlier permission sequence when the exact required suffix is final", () => {
    // Given: defaults or user permissions normalized to the same sequence before the owned suffix.
    const config: Record<string, unknown> = {};
    const expected = registerApprovalAgent(config);
    const permission = [
      ...APPROVAL_AGENT_PERMISSION_SUFFIX,
      { permission: "read", pattern: "*", action: "allow" as const },
      ...APPROVAL_AGENT_PERMISSION_SUFFIX,
    ];

    // When: strict runtime validation checks only the authoritative final three rules.
    const validated = validateResolvedApprovalAgent(
      [runtimeApprovalAgent({ prompt: expected.prompt, permission })],
      expected,
    );

    // Then: allowed earlier normalized rules do not create a false rejection.
    expect(validated.permission).toHaveLength(permission.length);
  });

  test.each([
    ["unknown field", { unexpected: true }],
    ["generated maxSteps", { maxSteps: 4 }],
    ["generated tools map", { tools: { opencode_smart_approval_read: true } }],
  ] as const)("rejects runtime schema drift from a %s", (_label, extra) => {
    // Given: a generated-declaration field that is absent from runtime Agent.Info.
    const config: Record<string, unknown> = {};
    const registered = registerApprovalAgent(config);
    const resolved = { ...runtimeApprovalAgent({ prompt: registered.prompt }), ...extra };

    // When/Then: strict unknown parsing rejects the drift.
    expect(() => validateResolvedApprovalAgent([resolved], registered)).toThrow(ApprovalAgentContractError);
  });

  test("rejects duplicate fixed-name runtime agents", () => {
    // Given: two source-valid runtime entries with the fixed name.
    const config: Record<string, unknown> = {};
    const registered = registerApprovalAgent(config);
    const resolved = runtimeApprovalAgent({ prompt: registered.prompt });

    // When/Then: exact-one identity validation rejects ambiguity.
    expect(() => validateResolvedApprovalAgent([resolved, resolved], registered)).toThrow(ApprovalAgentContractError);
  });

  test("rejects an unknown normalized permission action", () => {
    // Given: runtime data outside the pinned PermissionV1 rule schema.
    const config: Record<string, unknown> = {};
    const registered = registerApprovalAgent(config);
    const resolved = {
      ...runtimeApprovalAgent({ prompt: registered.prompt }),
      permission: [{ permission: "*", pattern: "*", action: "permit" }],
    };

    // When/Then: strict runtime parsing rejects schema drift before suffix validation.
    expect(() => validateResolvedApprovalAgent([resolved], registered)).toThrow(ApprovalAgentContractError);
  });
});
