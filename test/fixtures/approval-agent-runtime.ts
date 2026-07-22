import {
  APPROVAL_AGENT_DESCRIPTION,
  APPROVAL_AGENT_NAME,
  APPROVAL_AGENT_PERMISSION_SUFFIX,
} from "../../src/approval-agent";

export const runtimeApprovalAgent = (input: {
  readonly prompt: string;
  readonly model?: string;
  readonly permission?: readonly {
    readonly permission: string;
    readonly pattern: string;
    readonly action: "allow" | "ask" | "deny";
  }[];
}) => {
  const separator = input.model?.indexOf("/") ?? -1;
  const normalizedModel = input.model && separator > 0
    ? { providerID: input.model.slice(0, separator), modelID: input.model.slice(separator + 1) }
    : undefined;
  return {
    name: APPROVAL_AGENT_NAME,
    description: APPROVAL_AGENT_DESCRIPTION,
    mode: "subagent",
    native: false,
    temperature: 0,
    permission: input.permission ?? [
      { permission: "read", pattern: "*", action: "allow" },
      ...APPROVAL_AGENT_PERMISSION_SUFFIX,
    ],
    ...(normalizedModel ? { model: normalizedModel } : {}),
    prompt: input.prompt,
    options: {},
    steps: 4,
  };
};
