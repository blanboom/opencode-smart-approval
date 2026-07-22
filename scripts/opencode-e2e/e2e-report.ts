import type { RunningDeterministicProvider } from "../../test/fixtures/deterministic-openai-provider";
import { HarnessContractError } from "./errors";
import type { RunningLoopbackGuard, TcpListenerOwnership } from "./loopback-guard";
import { cappedJson, captureIsolatedLogs, describeAgentsEnvelope, summarizeLedger, summarizeProviderRequests } from "./reporting";
import type { ManagedOpenCode } from "./runtime-process";
import type { OwnedProcessLedger } from "./sampler";

type SuccessReportInput = {
  readonly version: string;
  readonly tempRoot: string;
  readonly binary: unknown;
  readonly dependency: unknown;
  readonly provider: RunningDeterministicProvider;
  readonly providerPortClosed: boolean;
  readonly guardOwnership: TcpListenerOwnership;
  readonly guardBeforeClose: TcpListenerOwnership;
  readonly guardPortClosed: boolean;
  readonly providerOwnership: TcpListenerOwnership;
  readonly boot: unknown;
  readonly inference: readonly unknown[];
  readonly agent: unknown;
  readonly observation: OwnedProcessLedger;
};

export const writeSuccessReport = (input: SuccessReportInput): void => {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    modes: ["boot-only", "inference"],
    version: input.version,
    tempRoot: input.tempRoot,
    binary: input.binary,
    dependency: input.dependency,
    provider: {
      pid: input.provider.pid,
      port: input.provider.port,
      portClosed: input.providerPortClosed,
      requests: summarizeProviderRequests(input.provider.state.requests),
    },
    guard: { ...input.guardOwnership, beforeClose: input.guardBeforeClose, portClosed: input.guardPortClosed },
    providerOwnership: input.providerOwnership,
    boot: input.boot,
    inference: input.inference,
    collision: { executedDefinition: "later same-name reader", markerObservedInReviewerInput: true },
    faults: ["malformed Responses event", "HTTP 500", "hang until review abort"],
    agent: input.agent,
    observation: summarizeLedger(input.observation),
    containmentClaim: "all configured endpoints were loopback and no non-loopback socket was observed; proxying plus observation is not an OS sandbox or proof against an unobserved short-lived direct socket",
  })}\n`);
};

type FailureReportInput = {
  readonly error: unknown;
  readonly opencode?: ManagedOpenCode;
  readonly provider: RunningDeterministicProvider;
  readonly guard?: RunningLoopbackGuard;
  readonly confirmationCaptures: Readonly<Record<string, unknown>>;
  readonly agentsEnvelope: unknown;
  readonly root: string;
  readonly baselineCaptures: Readonly<Record<string, unknown>>;
  readonly observation?: OwnedProcessLedger;
};

export const writeFailureReport = async (input: FailureReportInput): Promise<void> => {
  process.stderr.write(`${JSON.stringify({
    error: input.error instanceof HarnessContractError ? input.error.code : "unexpected",
    opencode: input.opencode === undefined ? undefined : {
      pid: input.opencode.pid,
      port: input.opencode.port,
      command: input.opencode.command,
      stdout: input.opencode.stdout.snapshot(),
      stderr: input.opencode.stderr.snapshot(),
    },
    provider: { pid: input.provider.pid, port: input.provider.port, requestCount: input.provider.state.requests.length },
    guard: input.guard === undefined ? undefined : { pid: input.guard.pid, port: input.guard.port, fd: input.guard.fd },
    confirmationCaptures: cappedJson(input.confirmationCaptures, input.root, 32_768),
    agentsEnvelope: cappedJson(input.agentsEnvelope, input.root, 8_192),
    agentsEnvelopeDetails: describeAgentsEnvelope(input.agentsEnvelope, input.root),
    logs: await captureIsolatedLogs(input.root),
    baselineCaptures: cappedJson(input.baselineCaptures, input.root, 24_576),
    observation: input.observation === undefined ? undefined : summarizeLedger(input.observation),
  })}\n`);
};
