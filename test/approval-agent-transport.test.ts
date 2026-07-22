import { describe, expect, test } from "bun:test";
import {
  APPROVAL_AGENT_DESCRIPTION,
  APPROVAL_AGENT_NAME,
  APPROVAL_AGENT_PERMISSION_SUFFIX,
  ApprovalAgentContractError,
  registerApprovalAgent,
  validateResolvedApprovalAgent,
} from "../src/approval-agent";

type PermissionAction = "allow" | "ask" | "deny";
const HOST_TOOL_OUTPUT_GLOB = "/private/tmp/fixture/data/opencode/tool-output/*";
const runtimeExpectation = { toolOutputGlob: HOST_TOOL_OUTPUT_GLOB };

const rule = (permission: string, pattern: string, action: PermissionAction) => ({ permission, pattern, action });

const defaultPermissionPrefix = () => [
  rule("*", "*", "allow"),
  rule("doom_loop", "*", "ask"),
  rule("external_directory", "*", "ask"),
  rule("external_directory", HOST_TOOL_OUTPUT_GLOB, "allow"),
  rule("external_directory", "/private/tmp/fixture/runtime/opencode/*", "allow"),
  rule("question", "*", "deny"),
  rule("plan_enter", "*", "deny"),
  rule("plan_exit", "*", "deny"),
  rule("read", "*", "allow"),
  rule("read", "*.env", "ask"),
  rule("read", "*.env.*", "ask"),
  rule("read", "*.env.example", "allow"),
];

const fixedTransportAgent = (prompt: string, appendHostRule = false) => ({
  name: APPROVAL_AGENT_NAME,
  description: APPROVAL_AGENT_DESCRIPTION,
  mode: "subagent",
  native: false,
  hidden: null,
  topP: null,
  temperature: 0,
  color: null,
  permission: [
    ...defaultPermissionPrefix(),
    ...APPROVAL_AGENT_PERMISSION_SUFFIX,
    ...(appendHostRule
      ? [rule("external_directory", HOST_TOOL_OUTPUT_GLOB, "allow")]
      : []),
  ],
  variant: null,
  prompt,
  options: {},
  steps: 4,
});

const collisionTransportAgent = () => ({
  name: "collision_agent",
  description: "Isolated custom-tool collision probe.",
  mode: "subagent",
  native: false,
  hidden: null,
  topP: null,
  temperature: 0,
  color: null,
  permission: [
    ...defaultPermissionPrefix(),
    rule("*", "*", "deny"),
    rule("collision_probe", "*", "allow"),
    rule("external_directory", HOST_TOOL_OUTPUT_GLOB, "allow"),
  ],
  variant: null,
  prompt: "Return only the observed collision probe result.",
  options: {},
  steps: 1,
});

const contractCode = (operation: () => void): string => {
  try {
    operation();
    return "accepted";
  } catch (error) {
    if (error instanceof ApprovalAgentContractError) return error.code;
    throw error;
  }
};

describe("app.agents runtime transport", () => {
  test("normalizes only the exact nullable transport fields from fixed and collision agents", () => {
    // Given exact 1.17.14 app.agents key and null shapes from the isolated SDK fixture.
    const expected = registerApprovalAgent({});
    const fixed = fixedTransportAgent(expected.prompt);
    const collision = collisionTransportAgent();
    const rawKeys = [
      "color", "description", "hidden", "mode", "name", "native", "options",
      "permission", "prompt", "steps", "temperature", "topP", "variant",
    ];

    // When the strict unknown boundary validates the complete runtime agent list.
    const validated = validateResolvedApprovalAgent([collision, fixed], expected);

    // Then transport nulls become absent, raw shapes stay pinned, and no debug-only field is accepted.
    expect(Object.keys(fixed).sort()).toEqual(rawKeys);
    expect(Object.keys(collision).sort()).toEqual(rawKeys);
    expect([fixed.hidden, fixed.topP, fixed.color, fixed.variant]).toEqual([null, null, null, null]);
    expect([collision.hidden, collision.topP, collision.color, collision.variant]).toEqual([null, null, null, null]);
    expect(["hidden", "topP", "color", "variant"].map((key) => key in validated)).toEqual([false, false, false, false]);
  });

  test("parses the exact host-appended fixed-agent response before enforcing the suffix", () => {
    // Given the isolated SDK response whose host-owned tool-output allow follows the authored suffix.
    const expected = registerApprovalAgent({});
    const fixed = fixedTransportAgent(expected.prompt, true);

    // When the runtime transport and security-contract stages execute in order.
    const code = contractCode(() => validateResolvedApprovalAgent([fixed], expected, runtimeExpectation));

    // Then nullable serialization and only the exact pinned host-managed trailing rule are accepted.
    expect(code).toBe("accepted");
  });

  test.each([
    ["arbitrary glob", [
      ...defaultPermissionPrefix(), ...APPROVAL_AGENT_PERMISSION_SUFFIX,
      rule("external_directory", "/private/tmp/other/opencode/tool-output/*", "allow"),
    ]],
    ["changed host action", [
      ...defaultPermissionPrefix(), ...APPROVAL_AGENT_PERMISSION_SUFFIX,
      rule("external_directory", HOST_TOOL_OUTPUT_GLOB, "ask"),
    ]],
    ["host rule before owned rules", [
      ...defaultPermissionPrefix(), rule("external_directory", HOST_TOOL_OUTPUT_GLOB, "allow"),
      ...APPROVAL_AGENT_PERMISSION_SUFFIX,
    ]],
    ["later extra rule", [
      ...defaultPermissionPrefix(), ...APPROVAL_AGENT_PERMISSION_SUFFIX,
      rule("external_directory", HOST_TOOL_OUTPUT_GLOB, "allow"),
      rule("bash", "*", "allow"),
    ]],
  ])("rejects a host-managed suffix with %s", (_label, permission) => {
    // Given a nullable SDK response whose final permission sequence differs from the pinned host contract.
    const expected = registerApprovalAgent({});
    const fixed = { ...fixedTransportAgent(expected.prompt), permission };

    // When validation receives the independently computed trusted tool-output glob.
    const code = contractCode(() => validateResolvedApprovalAgent([fixed], expected, runtimeExpectation));

    // Then no arbitrary host rule, changed action/order, or later rule is accepted.
    expect(code).toBe("permission_suffix_mismatch");
  });

  test.each([
    "relative/opencode/tool-output/*",
    "/private/tmp/*/opencode/tool-output/*",
    "/private/tmp/fixture/data/opencode/other/*",
  ])("rejects an invalid trusted host glob %s", (toolOutputGlob) => {
    // Given an expected host pattern not produced by the pinned Global.Path.data formula.
    const expected = registerApprovalAgent({});
    const fixed = fixedTransportAgent(expected.prompt, true);

    // When the trusted runtime expectation boundary validates its own input.
    const code = contractCode(() => validateResolvedApprovalAgent([fixed], expected, { toolOutputGlob }));

    // Then malformed expectation state fails before weakening permission matching.
    expect(code).toBe("invalid_config");
  });

  test.each([
    ["hidden", true],
    ["topP", 0.5],
    ["color", "#ffffff"],
    ["variant", "unsafe"],
  ])("rejects an explicit non-null %s override after transport normalization", (field, value) => {
    // Given a valid nullable transport response changed to a real authored override.
    const expected = registerApprovalAgent({});
    const fixed = { ...fixedTransportAgent(expected.prompt), [field]: value };

    // When the normalized runtime identity is compared with the immutable expectation.
    const code = contractCode(() => validateResolvedApprovalAgent([fixed], expected));

    // Then the override remains a fail-closed identity mismatch.
    expect(code).toBe("agent_identity_mismatch");
  });

  test.each([
    ["description", null],
    ["native", null],
    ["temperature", null],
    ["permission", null],
    ["model", null],
    ["prompt", null],
    ["options", null],
    ["steps", null],
  ])("rejects null for non-transport-nullable field %s", (field, value) => {
    // Given a null outside the four fields observed nullable in app.agents.
    const expected = registerApprovalAgent({});
    const fixed = { ...fixedTransportAgent(expected.prompt), [field]: value };

    // When strict runtime transport parsing executes.
    const code = contractCode(() => validateResolvedApprovalAgent([fixed], expected));

    // Then normalization does not broaden the accepted runtime schema.
    expect(code).toBe("invalid_runtime_schema");
  });

  test.each([
    ["debug tools", { tools: { opencode_smart_approval_read: true } }],
    ["implementation owner", { owner: "fixture-plugin" }],
  ])("rejects the %s field absent from SDK app.agents", (_label, extra) => {
    // Given a valid SDK transport value polluted with a debug-only or untrusted ownership claim.
    const expected = registerApprovalAgent({});
    const fixed = { ...fixedTransportAgent(expected.prompt), ...extra };

    // When the strict runtime boundary parses the unknown payload.
    const code = contractCode(() => validateResolvedApprovalAgent([fixed], expected));

    // Then unknown fields remain invalid rather than becoming transport-normalized.
    expect(code).toBe("invalid_runtime_schema");
  });
});
