import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunningDeterministicProvider, ProviderStep } from "../../test/fixtures/deterministic-openai-provider";
import type { HarnessConfigDocuments, ModelRoute } from "./config";
import { HarnessContractError } from "./errors";
import { appendBaselineSteps } from "./provider-plan";
import { cappedJson } from "./reporting";
import { runBaselineInference, runBlockedInference } from "./scenario-runner";
import type { ScenarioInputFactory } from "./confirmation-matrix";

type LateScenariosInput = {
  readonly baselineCaptures: Record<string, unknown>;
  readonly documentsFor: (route: ModelRoute, cleanup?: boolean, laterPluginUrl?: string) => HarnessConfigDocuments;
  readonly noncePath: string;
  readonly packageRoot: string;
  readonly provider: RunningDeterministicProvider;
  readonly providerSteps: ProviderStep[];
  readonly root: string;
  readonly scenarioInput: ScenarioInputFactory;
};

export const runLateScenarios = async (input: LateScenariosInput): Promise<readonly unknown[]> => {
  const collisionStart = input.provider.state.requests.length;
  const collisionDocuments = input.documentsFor(
    "small",
    true,
    pathToFileURL(join(input.packageRoot, "test", "fixtures", "same-name-reader.ts")).href,
  );
  appendBaselineSteps(input.providerSteps, "collision", input.noncePath, "fixture-reviewer");
  const collision = await runBaselineInference({
    ...input.scenarioInput("collision", collisionDocuments),
    expectedAgentModel: "openai/fixture-reviewer",
    provider: input.provider,
    reviewerModel: "fixture-reviewer",
    capture: (kind, value) => { input.baselineCaptures[`collision:${kind}`] = value; },
  });
  const collisionRequest = input.provider.state.requests[collisionStart + 2]?.request.input;
  if (!cappedJson(collisionRequest, input.root, 65_536).includes("SAME_NAME_READER:")) {
    throw new HarnessContractError("provider_request");
  }

  const mutationDocuments = input.documentsFor(
    "small",
    true,
    pathToFileURL(join(input.packageRoot, "test", "fixtures", "later-agent-mutator.ts")).href,
  );
  const mutationStart = input.provider.state.requests.length;
  input.providerSteps.push(
    { kind: "function", model: "fixture-primary", responseId: "resp-mutation-primary-tool", callId: "call-mutation-primary-bash", toolName: "bash", argumentsJson: JSON.stringify({ command: "printf main-ok" }) },
    { kind: "text", model: "fixture-primary", responseId: "resp-mutation-primary-final", messageId: "msg-mutation-primary-final", text: "mutation-blocked" },
  );
  const mutation = await runBlockedInference({
    ...input.scenarioInput("mutation", mutationDocuments),
    expectedText: "mutation-blocked",
  });
  if (
    input.provider.state.requests.length !== mutationStart + 2
    || input.provider.state.requests.slice(mutationStart).some((receipt) => receipt.request.model !== "fixture-primary")
  ) throw new HarnessContractError("provider_request");

  const faultDocuments = input.documentsFor("fault");
  input.providerSteps.push(
    { kind: "function", model: "fixture-primary", responseId: "resp-malformed-primary-tool", callId: "call-malformed-primary-bash", toolName: "bash", argumentsJson: JSON.stringify({ command: "printf main-ok" }) },
    { kind: "malformed", model: "fixture-fault" },
    { kind: "text", model: "fixture-primary", responseId: "resp-malformed-primary-final", messageId: "msg-malformed-primary-final", text: "malformed-blocked" },
  );
  const malformed = await runBlockedInference({
    ...input.scenarioInput("malformed", faultDocuments),
    expectedText: "malformed-blocked",
  });
  input.providerSteps.push(
    { kind: "function", model: "fixture-primary", responseId: "resp-http-error-primary-tool", callId: "call-http-error-primary-bash", toolName: "bash", argumentsJson: JSON.stringify({ command: "printf main-ok" }) },
    { kind: "http_error", model: "fixture-fault" },
    { kind: "text", model: "fixture-primary", responseId: "resp-http-error-primary-final", messageId: "msg-http-error-primary-final", text: "http-error-blocked" },
  );
  const httpError = await runBlockedInference({
    ...input.scenarioInput("http-error", faultDocuments),
    expectedText: "http-error-blocked",
  });

  const hangDocuments = input.documentsFor("hang");
  const hangStart = input.provider.state.requests.length;
  input.providerSteps.push(
    { kind: "function", model: "fixture-primary", responseId: "resp-hang-primary-tool", callId: "call-hang-primary-bash", toolName: "bash", argumentsJson: JSON.stringify({ command: "printf main-ok" }) },
    { kind: "hang", model: "fixture-hang" },
    { kind: "text", model: "fixture-primary", responseId: "resp-hang-primary-final", messageId: "msg-hang-primary-final", text: "hang-blocked" },
  );
  const hang = await runBlockedInference({ ...input.scenarioInput("hang", hangDocuments), expectedText: "hang-blocked" });
  if (
    input.provider.state.requests.length !== hangStart + 3
    || input.provider.state.abortedRequests?.length !== 1
    || input.provider.state.abortedRequests[0] !== hangStart + 1
  ) throw new HarnessContractError("provider_request");
  return Object.freeze([collision, mutation, malformed, httpError, hang]);
};
