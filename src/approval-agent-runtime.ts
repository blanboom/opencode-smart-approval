import { posix } from "node:path";
import { z } from "zod";
import {
  APPROVAL_AGENT_NAME,
  APPROVAL_AGENT_PERMISSION_SUFFIX,
  ApprovalAgentConfigSchema,
  ApprovalAgentContractError,
} from "./approval-agent-contract";

const RuntimePermissionRuleSchema = z.strictObject({
  permission: z.string(),
  pattern: z.string(),
  action: z.enum(["ask", "allow", "deny"]),
});

const RuntimeAgentInfoSchema = z.strictObject({
  name: z.string(),
  description: z.string().optional(),
  mode: z.enum(["subagent", "primary", "all"]),
  native: z.boolean().optional(),
  hidden: z.boolean().optional(),
  topP: z.number().finite().optional(),
  temperature: z.number().finite().optional(),
  color: z.string().optional(),
  permission: z.array(RuntimePermissionRuleSchema),
  model: z.strictObject({ modelID: z.string(), providerID: z.string() }).optional(),
  variant: z.string().optional(),
  prompt: z.string().optional(),
  options: z.record(z.string(), z.unknown()),
  steps: z.number().finite().optional(),
});

const RuntimeAgentListSchema = z.array(RuntimeAgentInfoSchema);
const RUNTIME_NULLABLE_UNSET_FIELDS = new Set(["hidden", "topP", "color", "variant"]);

const validToolOutputGlob = (value: string): boolean => {
  if (!posix.isAbsolute(value) || posix.normalize(value) !== value || value.includes("\0")) return false;
  const components = value.split("/").slice(1);
  if (components.length < 4 || components.some((component) => component.length === 0)) return false;
  if (components.at(-1) !== "*" || components.at(-2) !== "tool-output" || components.at(-3) !== "opencode") return false;
  return components.slice(0, -1).every((component) =>
    component !== "." && component !== ".." && !/[?*[\]{}]/u.test(component));
};

const RuntimeExpectationSchema = z.strictObject({
  toolOutputGlob: z.string().refine(validToolOutputGlob),
});

export type ResolvedApprovalAgent = Readonly<z.infer<typeof RuntimeAgentInfoSchema>>;

export type ApprovalAgentRuntimeExpectation = {
  readonly toolOutputGlob: string;
};

const normalizedModel = (model: string | undefined) => {
  if (model === undefined) return { kind: "absent" } as const;
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) return { kind: "invalid" } as const;
  return {
    kind: "present",
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  } as const;
};

const permissionRuleMatches = (
  actual: z.infer<typeof RuntimePermissionRuleSchema>,
  expected: Readonly<z.infer<typeof RuntimePermissionRuleSchema>>,
): boolean => actual.permission === expected.permission && actual.pattern === expected.pattern && actual.action === expected.action;

const hasExactPermissionSuffix = (
  permission: readonly z.infer<typeof RuntimePermissionRuleSchema>[],
  runtimeExpectation: ApprovalAgentRuntimeExpectation | undefined,
): boolean => {
  const hostRule = runtimeExpectation === undefined ? [] : [{
    permission: "external_directory",
    pattern: runtimeExpectation.toolOutputGlob,
    action: "allow",
  }] as const;
  const suffix = [...APPROVAL_AGENT_PERMISSION_SUFFIX, ...hostRule];
  const suffixLength = suffix.length;
  if (permission.length < suffixLength) return false;
  const finalStart = permission.length - suffixLength;
  return suffix.every((expected, offset) => {
    const actual = permission[finalStart + offset];
    return actual !== undefined && permissionRuleMatches(actual, expected);
  });
};

const normalizeRuntimeTransport = (input: unknown): unknown => {
  if (!Array.isArray(input)) return input;
  return input.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).filter(([key, field]) =>
      field !== null || !RUNTIME_NULLABLE_UNSET_FIELDS.has(key)));
  });
};

const hasExpectedModel = (agent: ResolvedApprovalAgent, model: string | undefined): boolean => {
  const expected = normalizedModel(model);
  switch (expected.kind) {
    case "absent":
      return agent.model === undefined;
    case "invalid":
      throw new ApprovalAgentContractError("invalid_config");
    case "present":
      return agent.model?.providerID === expected.providerID && agent.model.modelID === expected.modelID;
  }
};

export const validateResolvedApprovalAgent = (
  input: unknown,
  expectedInput: unknown,
  runtimeExpectationInput?: ApprovalAgentRuntimeExpectation,
): ResolvedApprovalAgent => {
  const expected = ApprovalAgentConfigSchema.safeParse(expectedInput);
  if (!expected.success) throw new ApprovalAgentContractError("invalid_config");
  const runtimeExpectation = runtimeExpectationInput === undefined
    ? undefined
    : RuntimeExpectationSchema.safeParse(runtimeExpectationInput);
  if (runtimeExpectation !== undefined && !runtimeExpectation.success) {
    throw new ApprovalAgentContractError("invalid_config");
  }
  const runtime = RuntimeAgentListSchema.safeParse(normalizeRuntimeTransport(input));
  if (!runtime.success) throw new ApprovalAgentContractError("invalid_runtime_schema");
  const matches = runtime.data.filter((agent) => agent.name === APPROVAL_AGENT_NAME);
  const agent = matches.length === 1 ? matches[0] : undefined;
  if (!agent) throw new ApprovalAgentContractError("agent_identity_mismatch");
  if (
    agent.description !== expected.data.description ||
    agent.prompt !== expected.data.prompt ||
    agent.mode !== "subagent" ||
    agent.steps !== 4 ||
    agent.temperature !== 0 ||
    agent.native !== false ||
    agent.hidden === true ||
    agent.topP !== undefined ||
    agent.color !== undefined ||
    agent.variant !== undefined ||
    Object.keys(agent.options).length !== 0 ||
    !hasExpectedModel(agent, expected.data.model)
  ) {
    throw new ApprovalAgentContractError("agent_identity_mismatch");
  }
  if (!hasExactPermissionSuffix(agent.permission, runtimeExpectation?.data)) {
    throw new ApprovalAgentContractError("permission_suffix_mismatch");
  }
  return agent;
};
