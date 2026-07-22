import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RunningDeterministicProvider } from "../../test/fixtures/deterministic-openai-provider";
import { preflightApprovalAgent } from "./agent-preflight";
import { runBaselineScenario, type BaselineCaptureKind } from "./baseline";
import { parseBlockedAssistant, parseBlockedTool } from "./blocked";
import type { HarnessConfigDocuments } from "./config";
import { countSessionRows } from "./database";
import { buildChildEnvironment, type HarnessDirectories } from "./environment";
import { HarnessContractError } from "./errors";
import { reserveClosedPort } from "./harness-setup";
import type { RunningLoopbackGuard } from "./loopback-guard";
import { startOpenCode, stopOpenCode, type ManagedOpenCode } from "./runtime-process";
import type { OwnedProcessMonitor } from "./sampler";
import { createScenarioDeadline } from "./scenario-deadline";
import {
  createHarnessClient,
  deadlineSignal,
  unwrapSdkData,
  unwrapSessionId,
  unwrapStatusMap,
  unwrapTrue,
} from "./sdk";

export type ScenarioInput = {
  readonly label: string;
  readonly documents: HarnessConfigDocuments;
  readonly executable: string;
  readonly directories: HarnessDirectories;
  readonly monitor: OwnedProcessMonitor;
  readonly guard: RunningLoopbackGuard;
  readonly setManaged: (managed: ManagedOpenCode | undefined) => void;
};

export type FinishedScenario = Readonly<{
  readonly stopped: Awaited<ReturnType<typeof stopOpenCode>>;
  readonly databaseCount: 0;
}>;

export const startScenario = async (input: ScenarioInput): Promise<ManagedOpenCode> => {
  writeFileSync(join(input.directories.config, "opencode", "command-approval.jsonc"), input.documents.policy, { mode: 0o600 });
  const environment = buildChildEnvironment({
    directories: input.directories,
    configContent: input.documents.opencode,
    closedProxyPort: await reserveClosedPort(),
    disableDefaultPlugins: false,
  });
  const managed = await startOpenCode({
    executable: input.executable,
    cwd: input.directories.workspace,
    environment,
    guard: input.guard,
  });
  input.setManaged(managed);
  input.monitor.add({ label: `${input.label}-opencode`, pid: managed.pid });
  input.monitor.checkpoint(`${input.label}-before`);
  return managed;
};

export const finishScenario = async (input: ScenarioInput, managed: ManagedOpenCode): Promise<FinishedScenario> => {
  const stopped = await stopOpenCode(managed);
  input.setManaged(undefined);
  input.monitor.checkpoint(`${input.label}-after`);
  input.monitor.retire(`${input.label}-opencode`);
  const databaseCount = countSessionRows(input.directories.database);
  if (databaseCount !== 0) throw new HarnessContractError("process");
  return Object.freeze({ stopped, databaseCount });
};

export const runBaselineInference = async (
  input: ScenarioInput & {
    readonly capture: (kind: BaselineCaptureKind, value: unknown) => void;
    readonly expectedAgentModel?: string;
    readonly provider: RunningDeterministicProvider;
    readonly reviewerModel: string;
  },
): Promise<unknown> => {
  const managed = await startScenario(input);
  const deadline = createScenarioDeadline();
  const running = { pid: managed.pid, port: managed.port, command: managed.command };
  const client = createHarnessClient(managed.origin, input.directories.workspace);
  const preflight = await preflightApprovalAgent({
    client,
    dataDirectory: input.directories.data,
    directory: input.directories.workspace,
    ...(input.expectedAgentModel === undefined ? {} : { expectedAgentModel: input.expectedAgentModel }),
    provider: input.provider,
    reviewerModel: input.reviewerModel,
    deadline,
  });
  const baseline = await runBaselineScenario(
    client,
    input.directories.workspace,
    deadline,
    input.capture,
  );
  const finished = await finishScenario(input, managed);
  return Object.freeze({ label: input.label, running, preflight, baseline, ...finished });
};

export const runBlockedInference = async (
  input: ScenarioInput & { readonly expectedText: string },
): Promise<unknown> => {
  const managed = await startScenario(input);
  const deadline = createScenarioDeadline();
  const running = { pid: managed.pid, port: managed.port, command: managed.command };
  const client = createHarnessClient(managed.origin, input.directories.workspace);
  const primarySessionID = unwrapSessionId(await deadline.run((signal) => client.session.create(
    { directory: input.directories.workspace, title: `opencode-smart-approval e2e ${input.label}` },
    { signal },
  )));
  let deleted = false;
  let blocked: unknown;
  try {
    const prompt = unwrapSdkData(await deadline.run((signal) => client.session.prompt({
      sessionID: primarySessionID,
      directory: input.directories.workspace,
      agent: "build",
      model: { providerID: "openai", modelID: "fixture-primary" },
      parts: [{ type: "text", text: "Call bash once with the exact command `printf main-ok`, then report the result." }],
    }, { signal })), z.unknown());
    const assistant = parseBlockedAssistant(prompt, primarySessionID, input.expectedText);
    const messages = unwrapSdkData(
      await deadline.run((signal) => client.session.messages(
        { sessionID: primarySessionID, directory: input.directories.workspace, limit: 64 },
        { signal },
      )),
      z.array(z.unknown()).min(2).max(64),
    );
    const tool = parseBlockedTool(messages, primarySessionID, "printf main-ok");
    const children = unwrapSdkData(
      await deadline.run((signal) => client.session.children(
        { sessionID: primarySessionID, directory: input.directories.workspace },
        { signal },
      )),
      z.array(z.object({ id: z.string().min(1) }).passthrough()).max(8),
    );
    const status = unwrapStatusMap(await deadline.run((signal) => client.session.status(
      { directory: input.directories.workspace },
      { signal },
    )));
    if (children.length !== 0 || Object.keys(status).length !== 0) throw new HarnessContractError("sdk_malformed");
    deleted = unwrapTrue(await deadline.run((signal) => client.session.delete(
      { sessionID: primarySessionID, directory: input.directories.workspace },
      { signal },
    )));
    blocked = Object.freeze({ ...assistant, ...tool, primarySessionID, childCount: 0, activeStatusCount: 0, deleted });
  } finally {
    if (!deleted) {
      unwrapTrue(await client.session.delete(
        { sessionID: primarySessionID, directory: input.directories.workspace },
        { signal: deadlineSignal(2_000) },
      ));
    }
  }
  const finished = await finishScenario(input, managed);
  return Object.freeze({ label: input.label, running, blocked, ...finished });
};
