import { join } from "node:path";
import { z } from "zod";
import { registerApprovalAgent, validateResolvedApprovalAgent } from "../../src/approval-agent";
import type { RunningDeterministicProvider } from "../../test/fixtures/deterministic-openai-provider";
import { HarnessContractError } from "./errors";
import type { ScenarioDeadline } from "./scenario-deadline";
import { type HarnessClient, unwrapSdkData } from "./sdk";

export type AgentPreflightReceipt = Readonly<{
  readonly durationMilliseconds: number;
  readonly providerRequestDelta: 0;
  readonly reviewerModel: string;
}>;

export const preflightApprovalAgent = async (input: Readonly<{
  client: HarnessClient;
  dataDirectory: string;
  directory: string;
  expectedAgentModel?: string;
  provider: RunningDeterministicProvider;
  reviewerModel: string;
  deadline: ScenarioDeadline;
}>): Promise<AgentPreflightReceipt> => {
  const providerRequestsBefore = input.provider.state.requests.length;
  const started = performance.now();
  const agents = unwrapSdkData(
    await input.deadline.run((signal) => input.client.app.agents(
      { directory: input.directory },
      { signal },
    )),
    z.array(z.unknown()).min(1).max(32),
  );
  const expected = registerApprovalAgent(input.expectedAgentModel === undefined
    ? {}
    : { small_model: input.expectedAgentModel });
  validateResolvedApprovalAgent(agents, expected, {
    toolOutputGlob: join(input.dataDirectory, "opencode", "tool-output", "*"),
  });
  if (input.provider.state.requests.length !== providerRequestsBefore) {
    throw new HarnessContractError("provider_request");
  }
  return Object.freeze({
    durationMilliseconds: Math.ceil(performance.now() - started),
    providerRequestDelta: 0,
    reviewerModel: input.reviewerModel,
  });
};
