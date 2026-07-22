import type { ProviderRequestReceipt } from "../../test/fixtures/deterministic-openai-provider";
import type { OwnedProcessLedger } from "./sampler";

const asRecord = (input: unknown): Readonly<Record<string, unknown>> | undefined => (
  typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Readonly<Record<string, unknown>>
    : undefined
);

const AUTHORIZATION_PHRASE_PATTERN = /AUTHORIZE opencode-smart-approval [A-Za-z0-9_-]{43}/gu;

export const redactEvidenceText = (input: string, root: string): string => input
  .replaceAll(root, "<temp-root>")
  .replace(AUTHORIZATION_PHRASE_PATTERN, "<authorization-phrase>");

export const summarizeProviderRequests = (requests: readonly ProviderRequestReceipt[]): readonly unknown[] => Object.freeze(
  requests.map((receipt) => Object.freeze({
    index: receipt.index,
    path: receipt.path,
    model: receipt.request.model,
    inputCount: receipt.request.input.length,
    inputRoles: Object.freeze(receipt.request.input.flatMap((item) => {
      const role = asRecord(item)?.["role"];
      return typeof role === "string" ? [role] : [];
    })),
    toolNames: Object.freeze(receipt.request.tools.flatMap((tool) => {
      const name = asRecord(tool)?.["name"];
      return typeof name === "string" ? [name] : [];
    }).sort()),
  })),
);

export const summarizeLedger = (ledger: OwnedProcessLedger): unknown => Object.freeze({
  intervalMilliseconds: ledger.intervalMilliseconds,
  socketSampleCount: ledger.socketSamples.length,
  nonEmptySocketSampleCount: ledger.socketSamples.filter((sample) => sample.sockets.length > 0).length,
  ownedPids: Object.freeze([...new Map(ledger.socketSamples.map((sample) => [sample.label, sample.pid])).entries()]
    .map(([label, pid]) => Object.freeze({ label, pid }))),
  openedFileCheckpoints: Object.freeze(ledger.openedFileCheckpoints.map((checkpoint) => Object.freeze({
    stage: checkpoint.stage,
    label: checkpoint.label,
    pid: checkpoint.pid,
    pathCount: checkpoint.paths.length,
  }))),
});

export const cappedJson = (input: unknown, root: string, limit: number): string => (
  redactEvidenceText(JSON.stringify(input) ?? "undefined", root).slice(0, limit)
);

export const describeAgentsEnvelope = (input: unknown, root: string): unknown => {
  if (typeof input !== "object" || input === null) return { kind: typeof input };
  const error = Reflect.get(input, "error");
  const request = Reflect.get(input, "request");
  return {
    error: error instanceof Error
      ? { name: error.name, message: redactEvidenceText(error.message, root) }
      : { kind: typeof error, keys: typeof error === "object" && error !== null ? Object.keys(error) : [] },
    request: request instanceof Request
      ? { method: request.method, url: redactEvidenceText(request.url, root), signalAborted: request.signal.aborted }
      : { kind: typeof request },
  };
};

export const captureIsolatedLogs = async (root: string): Promise<Readonly<Record<string, string>>> => {
  const logs: Record<string, string> = {};
  for await (const path of new Bun.Glob("**/*.log").scan({ cwd: root, absolute: true, onlyFiles: true })) {
    logs[path.replace(root, "<temp-root>")] = redactEvidenceText(await Bun.file(path).text(), root).slice(0, 16_384);
  }
  return Object.freeze(logs);
};
