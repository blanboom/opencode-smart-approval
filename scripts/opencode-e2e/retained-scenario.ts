import { z } from "zod";
import { APPROVAL_AGENT_NAME } from "../../src/approval-agent";
import { REVIEW_CHILD_TITLE } from "../../src/opencode-reviewer";
import type { RunningDeterministicProvider } from "../../test/fixtures/deterministic-openai-provider";
import { preflightApprovalAgent } from "./agent-preflight";
import { parseBaselineAssistant, parseBaselineMessages } from "./baseline";
import { HarnessContractError } from "./errors";
import { parseRetainedChild, parseRetainedReaderProbe, requireRetainedStatusAbsent } from "./retained";
import { finishScenario, startScenario, type ScenarioInput } from "./scenario-runner";
import { createScenarioDeadline } from "./scenario-deadline";
import {
  createHarnessClient,
  deadlineSignal,
  unwrapSdkData,
  unwrapSessionId,
  unwrapStatusMap,
  unwrapTrue,
} from "./sdk";

const ParentSessionSchema = z.object({
  id: z.string().regex(/^ses_[A-Za-z0-9_-]+$/u),
  projectID: z.string().min(1),
  directory: z.string().min(1),
}).passthrough();

export const runRetainedInference = async (
  input: ScenarioInput & {
    readonly noncePath: string;
    readonly provider: RunningDeterministicProvider;
    readonly reviewerModel: string;
  },
): Promise<unknown> => {
  const managed = await startScenario(input);
  const deadline = createScenarioDeadline();
  const running = { pid: managed.pid, port: managed.port, command: managed.command, listener: managed.listener };
  const client = createHarnessClient(managed.origin, input.directories.workspace);
  const preflight = await preflightApprovalAgent({
    client,
    dataDirectory: input.directories.data,
    directory: input.directories.workspace,
    expectedAgentModel: `openai/${input.reviewerModel}`,
    provider: input.provider,
    reviewerModel: input.reviewerModel,
    deadline,
  });
  const primarySessionID = unwrapSessionId(await deadline.run((signal) => client.session.create(
    { directory: input.directories.workspace, title: "opencode-smart-approval e2e retained" },
    { signal },
  )));
  let primaryDeleted = false;
  let childID: string | undefined;
  let childDeleted = false;
  try {
    const parent = unwrapSdkData(await deadline.run((signal) => client.session.get(
      { sessionID: primarySessionID, directory: input.directories.workspace },
      { signal },
    )), ParentSessionSchema);
    const prompt = unwrapSdkData(await deadline.run((signal) => client.session.prompt({
      sessionID: primarySessionID,
      directory: input.directories.workspace,
      agent: "build",
      model: { providerID: "openai", modelID: "fixture-primary" },
      parts: [{ type: "text", text: "Call bash once with the exact command `printf main-ok`, then return main-ok." }],
    }, { signal })), z.unknown());
    const assistant = parseBaselineAssistant(prompt, primarySessionID);
    const primaryMessages = unwrapSdkData(await deadline.run((signal) => client.session.messages(
      { sessionID: primarySessionID, directory: input.directories.workspace, limit: 64 },
      { signal },
    )), z.array(z.unknown()).min(2).max(64));
    const tool = parseBaselineMessages(primaryMessages, primarySessionID);
    const children = unwrapSdkData(await deadline.run((signal) => client.session.children(
      { sessionID: primarySessionID, directory: input.directories.workspace },
      { signal },
    )), z.array(z.unknown()).length(1));
    const listedID = z.object({ id: z.string().regex(/^ses_[A-Za-z0-9_-]+$/u) }).passthrough().parse(children[0]).id;
    const fetched = unwrapSdkData(await deadline.run((signal) => client.session.get(
      { sessionID: listedID, directory: input.directories.workspace },
      { signal },
    )), z.unknown());
    const retained = parseRetainedChild(children, fetched, {
      projectID: parent.projectID,
      directory: input.directories.workspace,
      parentID: primarySessionID,
      title: REVIEW_CHILD_TITLE,
    });
    const retainedChildID = retained.childID;
    childID = retainedChildID;
    const statusBeforeProbe = unwrapStatusMap(await deadline.run((signal) => client.session.status(
      { directory: input.directories.workspace },
      { signal },
    )));
    requireRetainedStatusAbsent(statusBeforeProbe, retainedChildID);
    unwrapSdkData(await deadline.run((signal) => client.session.prompt({
      sessionID: retainedChildID,
      directory: input.directories.workspace,
      agent: APPROVAL_AGENT_NAME,
      model: { providerID: "openai", modelID: input.reviewerModel },
      parts: [{ type: "text", text: `Call opencode_smart_approval_read once for ${input.noncePath} at offset 0.` }],
    }, { signal })), z.unknown());
    const childMessages = unwrapSdkData(await deadline.run((signal) => client.session.messages(
      { sessionID: retainedChildID, directory: input.directories.workspace, limit: 64 },
      { signal },
    )), z.array(z.unknown()).min(2).max(64));
    const probe = parseRetainedReaderProbe(childMessages, retainedChildID, input.noncePath);
    const statusAfterProbe = unwrapStatusMap(await deadline.run((signal) => client.session.status(
      { directory: input.directories.workspace },
      { signal },
    )));
    requireRetainedStatusAbsent(statusAfterProbe, retainedChildID);
    childDeleted = unwrapTrue(await deadline.run((signal) => client.session.delete(
      { sessionID: retainedChildID, directory: input.directories.workspace },
      { signal },
    )));
    primaryDeleted = unwrapTrue(await deadline.run((signal) => client.session.delete(
      { sessionID: primarySessionID, directory: input.directories.workspace },
      { signal },
    )));
    const finished = await finishScenario(input, managed);
    return Object.freeze({
      label: input.label,
      running,
      preflight,
      baseline: { ...assistant, ...tool },
      retained,
      statusBeforeProbeAbsent: true,
      probe,
      statusAfterProbeAbsent: true,
      childDeleted,
      primaryDeleted,
      ...finished,
    });
  } finally {
    if (childID !== undefined && !childDeleted) {
      unwrapTrue(await client.session.delete(
        { sessionID: childID, directory: input.directories.workspace },
        { signal: deadlineSignal(2_000) },
      ));
    }
    if (!primaryDeleted) {
      unwrapTrue(await client.session.delete(
        { sessionID: primarySessionID, directory: input.directories.workspace },
        { signal: deadlineSignal(2_000) },
      ));
    }
  }
};
