import { join } from "node:path";
import type { RunningDeterministicProvider, ProviderStep } from "../../test/fixtures/deterministic-openai-provider";
import type { HarnessConfigDocuments } from "./config";
import { appendConfirmationScenarioSteps, type ConfirmationScenarioKind } from "./confirmation-provider-plan";
import { runConfirmationInference } from "./confirmation-scenario";
import { HarnessContractError } from "./errors";
import type { ScenarioInput } from "./scenario-runner";

export type ScenarioInputFactory = (label: string, documents: HarnessConfigDocuments) => ScenarioInput;

type ConfirmationMatrixInput = {
  readonly documents: HarnessConfigDocuments;
  readonly noncePath: string;
  readonly provider: RunningDeterministicProvider;
  readonly providerSteps: ProviderStep[];
  readonly scenarioInput: ScenarioInputFactory;
  readonly workspace: string;
  readonly capture: (kind: ConfirmationScenarioKind, stage: string, value: unknown) => void;
};

const kinds: readonly ConfirmationScenarioKind[] = Object.freeze([
  "happy-replay",
  "preauthorization",
  "generic",
  "stale",
  "boundary-eviction",
  "two-users",
  "synthetic",
  "assistant-copy",
  "altered-effect",
]);

export const runConfirmationMatrix = async (input: ConfirmationMatrixInput): Promise<readonly unknown[]> => {
  const receipts: unknown[] = [];
  for (const kind of kinds) {
    const marker = join(input.workspace, `confirmation-${kind}.txt`);
    const alteredMarker = join(input.workspace, `confirmation-${kind}-altered.txt`);
    const commands = {
      primary: `printf confirmed >> ${JSON.stringify(marker)}`,
      ...(kind === "stale" || kind === "altered-effect"
        ? { altered: `printf confirmed >> ${JSON.stringify(alteredMarker)}` }
        : {}),
    };
    const expectedRequestCount = appendConfirmationScenarioSteps(input.providerSteps, kind, commands, input.noncePath);
    receipts.push(await runConfirmationInference({
      ...input.scenarioInput(`confirmation-${kind}`, input.documents),
      kind,
      commands,
      markerPaths: commands.altered === undefined ? [marker] : [marker, alteredMarker],
      provider: input.provider,
      expectedRequestCount,
      capture: (stage, value) => input.capture(kind, stage, value),
    }));
  }
  if (input.provider.state.requests.length !== 82) throw new HarnessContractError("provider_request");
  return Object.freeze(receipts);
};
