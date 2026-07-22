import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { APPROVAL_AGENT_NAME, registerApprovalAgent, validateResolvedApprovalAgent } from "../src/approval-agent";
import { startDeterministicProvider, type ProviderStep } from "../test/fixtures/deterministic-openai-provider";
import { inspectLocalOpenCodeBinary } from "./opencode-e2e/binary";
import { buildHarnessConfigDocuments, type ModelRoute } from "./opencode-e2e/config";
import { runConfirmationMatrix } from "./opencode-e2e/confirmation-matrix";
import { countSessionRows } from "./opencode-e2e/database";
import { seedIsolatedPluginDependency } from "./opencode-e2e/dependency-seed";
import { writeFailureReport, writeSuccessReport } from "./opencode-e2e/e2e-report";
import { buildChildEnvironment } from "./opencode-e2e/environment";
import { HarnessContractError } from "./opencode-e2e/errors";
import {
  createHarnessDirectories,
  directoriesFor,
  requireOpenCodeVersion,
  reserveClosedPort,
} from "./opencode-e2e/harness-setup";
import {
  acquireLoopbackGuard,
  closeLoopbackGuard,
  requireLoopbackGuard,
  requireOwnedTcpListener,
  type RunningLoopbackGuard,
} from "./opencode-e2e/loopback-guard";
import { runLateScenarios } from "./opencode-e2e/late-scenarios";
import { appendBaselineSteps, appendRetainedProbeSteps } from "./opencode-e2e/provider-plan";
import { cappedJson } from "./opencode-e2e/reporting";
import { startOpenCode, stopOpenCode, waitForPortClosure, type ManagedOpenCode } from "./opencode-e2e/runtime-process";
import { OwnedProcessMonitor, type OwnedProcessLedger } from "./opencode-e2e/sampler";
import { runBaselineInference, runBlockedInference } from "./opencode-e2e/scenario-runner";
import { runRetainedInference } from "./opencode-e2e/retained-scenario";
import { createHarnessClient, deadlineSignal, unwrapSdkData } from "./opencode-e2e/sdk";
import { z } from "zod";

const packageRoot = resolve(import.meta.dir, "..");
const AgentSchema = z.object({ name: z.string(), mode: z.enum(["subagent", "primary", "all"]) }).passthrough();

const main = async (): Promise<void> => {
  if (Bun.version !== "1.3.14") throw new HarnessContractError("binary_contract");
  const binary = inspectLocalOpenCodeBinary(packageRoot);
  const root = mkdtempSync("/private/tmp/opencode-smart-approval-e2e-");
  const directories = directoriesFor(root);
  let opencode: ManagedOpenCode | undefined;
  let guard: RunningLoopbackGuard | undefined;
  let agentsEnvelope: unknown;
  let monitorLedger: OwnedProcessLedger | undefined;
  let monitorStopped = false;
  const baselineCaptures: Record<string, unknown> = {};
  const confirmationCaptures: Record<string, unknown> = {};
  const providerSteps: ProviderStep[] = [];
  const provider = startDeterministicProvider(providerSteps);
  const monitor = new OwnedProcessMonitor(homedir());
  const pluginUrl = pathToFileURL(join(packageRoot, "src", "index.ts")).href;
  const documentsFor = (
    modelRoute: ModelRoute,
    cleanupSession = true,
    laterPluginUrl?: string,
  ): ReturnType<typeof buildHarnessConfigDocuments> => buildHarnessConfigDocuments({
    providerOrigin: `${provider.origin}/v1`,
    pluginUrl,
    ...(laterPluginUrl === undefined ? {} : { laterPluginUrl }),
    modelRoute,
    cleanupSession,
  });
  try {
    const activeGuard = acquireLoopbackGuard();
    guard = activeGuard;
    const guardOwnership = requireLoopbackGuard(activeGuard);
    const providerOwnership = requireOwnedTcpListener(provider.pid, provider.port);
    monitor.add({ label: "guard", pid: activeGuard.pid });
    monitor.add({ label: "provider", pid: provider.pid });
    monitor.start();
    monitor.checkpoint("provider-start");
    createHarnessDirectories(directories);
    const documents = documentsFor("small");
    mkdirSync(join(directories.config, "opencode"), { recursive: true });
    const dependency = seedIsolatedPluginDependency(packageRoot, join(directories.config, "opencode"));
    writeFileSync(join(directories.config, "opencode", "command-approval.jsonc"), documents.policy, { mode: 0o600 });
    const environment = buildChildEnvironment({
      directories,
      configContent: documents.opencode,
      closedProxyPort: await reserveClosedPort(),
      disableDefaultPlugins: true,
    });
    const version = requireOpenCodeVersion(binary.executable, environment);
    opencode = await startOpenCode({
      executable: binary.executable,
      cwd: directories.workspace,
      environment,
      guard: activeGuard,
    });
    monitor.add({ label: "boot-opencode", pid: opencode.pid });
    monitor.checkpoint("boot-before");
    const client = createHarnessClient(opencode.origin, directories.workspace);
    agentsEnvelope = await client.app.agents({ directory: directories.workspace }, { signal: deadlineSignal(5_000) });
    const agents = unwrapSdkData(agentsEnvelope, z.array(AgentSchema));
    const matches = agents.filter((agent) => agent.name === APPROVAL_AGENT_NAME);
    if (matches.length !== 1 || matches[0]?.mode !== "subagent") throw new HarnessContractError("sdk_malformed");
    const expectedAgent = registerApprovalAgent({ small_model: "openai/fixture-reviewer" });
    const fixedAgent = validateResolvedApprovalAgent(agents, expectedAgent, {
      toolOutputGlob: join(directories.data, "opencode", "tool-output", "*"),
    });
    const bootRunning = { pid: opencode.pid, port: opencode.port, command: opencode.command };
    const bootStopped = await stopOpenCode(opencode);
    opencode = undefined;
    monitor.checkpoint("boot-after");
    monitor.retire("boot-opencode");
    const bootDatabaseCount = countSessionRows(directories.database);
    if (bootDatabaseCount !== 0) throw new HarnessContractError("process");
    const noncePath = join(directories.workspace, "review-nonce.txt");
    writeFileSync(noncePath, "approval-e2e-nonce\n", { mode: 0o600 });
    const scenarioInput = (label: string, scenarioDocuments: ReturnType<typeof buildHarnessConfigDocuments>) => ({
      label,
      documents: scenarioDocuments,
      executable: binary.executable,
      directories,
      monitor,
      guard: activeGuard,
      setManaged: (managed: ManagedOpenCode | undefined) => { opencode = managed; },
    });
    appendBaselineSteps(providerSteps, "small", noncePath, "fixture-reviewer");
    const smallInference = await runBaselineInference({
      ...scenarioInput("small", documents),
      expectedAgentModel: "openai/fixture-reviewer",
      provider,
      reviewerModel: "fixture-reviewer",
      capture: (kind, input) => { baselineCaptures[`small:${kind}`] = input; },
    });
    const explicitDocuments = documentsFor("explicit");
    appendBaselineSteps(providerSteps, "explicit", noncePath, "fixture-explicit");
    const explicitInference = await runBaselineInference({
      ...scenarioInput("explicit", explicitDocuments),
      expectedAgentModel: "openai/fixture-explicit",
      provider,
      reviewerModel: "fixture-explicit",
      capture: (kind, input) => { baselineCaptures[`explicit:${kind}`] = input; },
    });
    const inheritedDocuments = documentsFor("inherited");
    appendBaselineSteps(providerSteps, "inherited", noncePath, "fixture-primary");
    const inheritedInference = await runBaselineInference({
      ...scenarioInput("inherited", inheritedDocuments),
      provider,
      reviewerModel: "fixture-primary",
      capture: (kind, input) => { baselineCaptures[`inherited:${kind}`] = input; },
    });
    const retainedDocuments = documentsFor("small", false);
    appendBaselineSteps(providerSteps, "retained", noncePath, "fixture-reviewer");
    appendRetainedProbeSteps(providerSteps, "retained", noncePath, "fixture-reviewer");
    const retainedInference = await runRetainedInference({
      ...scenarioInput("retained", retainedDocuments),
      noncePath,
      provider,
      reviewerModel: "fixture-reviewer",
    });
    if (provider.state.requests.length !== 18) throw new HarnessContractError("provider_request");
    const confirmationInference = await runConfirmationMatrix({
      documents,
      noncePath,
      provider,
      providerSteps,
      scenarioInput,
      workspace: directories.workspace,
      capture: (kind, stage, value) => { confirmationCaptures[`${kind}:${stage}`] = value; },
    });
    const lateInference = await runLateScenarios({
      baselineCaptures,
      documentsFor,
      noncePath,
      packageRoot,
      provider,
      providerSteps,
      root,
      scenarioInput,
    });
    monitorLedger = await monitor.stop();
    monitorStopped = true;
    const guardBeforeClose = requireLoopbackGuard(activeGuard);
    await provider.stop();
    const providerPortClosed = await waitForPortClosure(provider.port, 5_000);
    await closeLoopbackGuard(activeGuard);
    const guardPortClosed = await waitForPortClosure(activeGuard.port, 5_000);
    writeSuccessReport({
      version,
      tempRoot: directories.root,
      binary,
      dependency,
      provider,
      providerPortClosed,
      guardOwnership,
      guardBeforeClose,
      guardPortClosed,
      providerOwnership,
      boot: { opencode: bootRunning, stopped: bootStopped, databaseCount: bootDatabaseCount },
      inference: [
        smallInference,
        explicitInference,
        inheritedInference,
        retainedInference,
        ...confirmationInference,
        ...lateInference,
      ],
      agent: {
        name: fixedAgent.name,
        mode: fixedAgent.mode,
        steps: fixedAgent.steps,
        temperature: fixedAgent.temperature,
        native: fixedAgent.native,
        hidden: fixedAgent.hidden ?? false,
        model: fixedAgent.model,
        permissionSuffix: fixedAgent.permission.slice(-4),
      },
      observation: monitorLedger,
    });
  } catch (error) {
    await writeFailureReport({
      error,
      ...(opencode === undefined ? {} : { opencode }),
      provider,
      ...(guard === undefined ? {} : { guard }),
      confirmationCaptures,
      agentsEnvelope,
      root,
      baselineCaptures,
      ...(monitorLedger === undefined ? {} : { observation: monitorLedger }),
    });
    throw error;
  } finally {
    if (opencode) await stopOpenCode(opencode);
    if (!monitorStopped) {
      try {
        monitorLedger = await monitor.stop();
      } catch (cleanupError) {
        if (!(cleanupError instanceof Error)) throw cleanupError;
        process.stderr.write(`${cappedJson(cleanupError.message, root, 1_024)}\n`);
      }
    }
    await provider.stop();
    await waitForPortClosure(provider.port, 5_000);
    if (guard !== undefined) {
      await closeLoopbackGuard(guard);
      await waitForPortClosure(guard.port, 5_000);
    }
    rmSync(root, { recursive: true, force: true });
  }
};

await main();
