import { HarnessContractError } from "./errors";
import { parseLsofSockets, requireLoopbackSockets, type SocketReceipt } from "./network";

const textDecoder = new TextDecoder();

export type OwnedPid = {
  readonly label: string;
  readonly pid: number;
};

export type SocketSample = {
  readonly sequence: number;
  readonly label: string;
  readonly pid: number;
  readonly sockets: readonly SocketReceipt[];
};

export type OpenedFileCheckpoint = {
  readonly stage: string;
  readonly label: string;
  readonly pid: number;
  readonly paths: readonly string[];
};

export type OwnedProcessLedger = {
  readonly intervalMilliseconds: 50;
  readonly socketSamples: readonly SocketSample[];
  readonly openedFileCheckpoints: readonly OpenedFileCheckpoint[];
};

export const buildLsofNetworkCommand = (pid: number): readonly string[] => {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new HarnessContractError("socket");
  return Object.freeze(["/usr/sbin/lsof", "-nP", "-a", "-p", String(pid), "-iTCP", "-iUDP", "-w"]);
};

export const buildLsofFilesCommand = (pid: number): readonly string[] => {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new HarnessContractError("socket");
  return Object.freeze(["/usr/sbin/lsof", "-nP", "-a", "-p", String(pid), "-Fn", "-w"]);
};

export const parseLsofExit = (exitCode: number, stdout: string, stderr: string): string => {
  if ((exitCode === 0 || exitCode === 1) && stderr.length === 0) return stdout;
  throw new HarnessContractError("socket");
};

export const parseLsofFileNames = (stdout: string): readonly string[] => Object.freeze(
  [...new Set(stdout.split(/\r?\n/u)
    .filter((line) => line.startsWith("n/"))
    .map((line) => line.slice(1)))]
    .sort(),
);

export const requireNoOwnerOpenCodePaths = (paths: readonly string[], ownerHome: string): void => {
  if (!ownerHome.startsWith("/") || ownerHome === "/") throw new HarnessContractError("environment");
  const forbidden = [
    `${ownerHome}/.config/opencode`,
    `${ownerHome}/.local/share/opencode`,
    `${ownerHome}/.local/state/opencode`,
    `${ownerHome}/.cache/opencode`,
    `${ownerHome}/Library/Application Support/opencode`,
    `${ownerHome}/Library/Caches/opencode`,
    `${ownerHome}/Library/Preferences/opencode`,
  ];
  if (paths.some((path) => forbidden.some((root) => path === root || path.startsWith(`${root}/`)))) {
    throw new HarnessContractError("environment");
  }
};

const runLsof = (command: readonly string[]): string => {
  const result = Bun.spawnSync({ cmd: [...command], stdout: "pipe", stderr: "pipe" });
  return parseLsofExit(result.exitCode, textDecoder.decode(result.stdout), textDecoder.decode(result.stderr));
};

const runLsofAsync = async (command: readonly string[]): Promise<string> => {
  const child = Bun.spawn({ cmd: [...command], stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return parseLsofExit(exitCode, stdout, stderr);
};

export class OwnedProcessMonitor {
  readonly #owned = new Map<string, number>();
  readonly #socketSamples: SocketSample[] = [];
  readonly #openedFileCheckpoints: OpenedFileCheckpoint[] = [];
  readonly #ownerHome: string;
  #samplePromise: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #sequence = 0;
  #failure: unknown;

  constructor(ownerHome: string) {
    if (!ownerHome.startsWith("/") || ownerHome === "/") throw new HarnessContractError("environment");
    this.#ownerHome = ownerHome;
  }

  add(input: OwnedPid): void {
    if (this.#owned.has(input.label) || !Number.isSafeInteger(input.pid) || input.pid < 1) {
      throw new HarnessContractError("process");
    }
    this.#owned.set(input.label, input.pid);
  }

  retire(label: string): void {
    if (!this.#owned.delete(label)) throw new HarnessContractError("process");
  }

  start(): void {
    if (this.#timer !== undefined) throw new HarnessContractError("process");
    this.#sampleSockets();
    this.#timer = setInterval(() => this.#scheduleSocketSample(), 50);
  }

  checkpoint(stage: string): void {
    if (stage.length === 0) throw new HarnessContractError("process");
    this.#throwFailure();
    this.#sampleSockets();
    for (const [label, pid] of this.#owned) {
      const paths = parseLsofFileNames(runLsof(buildLsofFilesCommand(pid)));
      requireNoOwnerOpenCodePaths(paths, this.#ownerHome);
      this.#openedFileCheckpoints.push(Object.freeze({ stage, label, pid, paths }));
    }
    this.#throwFailure();
  }

  async stop(): Promise<OwnedProcessLedger> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#samplePromise;
    this.#throwFailure();
    return Object.freeze({
      intervalMilliseconds: 50,
      socketSamples: Object.freeze([...this.#socketSamples]),
      openedFileCheckpoints: Object.freeze([...this.#openedFileCheckpoints]),
    });
  }

  #scheduleSocketSample(): void {
    if (this.#samplePromise !== undefined || this.#failure !== undefined) return;
    const sample = this.#sampleSocketsAsync();
    this.#samplePromise = sample;
    void sample.then(() => {
      if (this.#samplePromise === sample) this.#samplePromise = undefined;
    });
  }

  async #sampleSocketsAsync(): Promise<void> {
    try {
      const owned = [...this.#owned];
      const outputs = await Promise.all(owned.map(async ([label, pid]) => ({
        label,
        pid,
        stdout: await runLsofAsync(buildLsofNetworkCommand(pid)),
      })));
      for (const output of outputs) {
        const sockets = parseLsofSockets(output.stdout, output.pid);
        requireLoopbackSockets(sockets);
        this.#socketSamples.push(Object.freeze({
          sequence: this.#sequence,
          label: output.label,
          pid: output.pid,
          sockets,
        }));
      }
      this.#sequence += 1;
    } catch (error) {
      this.#failure = error instanceof Error ? error : new HarnessContractError("socket");
    }
  }

  #sampleSockets(): void {
    if (this.#failure !== undefined) return;
    try {
      for (const [label, pid] of this.#owned) {
        const stdout = runLsof(buildLsofNetworkCommand(pid));
        const sockets = parseLsofSockets(stdout, pid);
        requireLoopbackSockets(sockets);
        this.#socketSamples.push(Object.freeze({
          sequence: this.#sequence,
          label,
          pid,
          sockets,
        }));
      }
      this.#sequence += 1;
    } catch (error) {
      this.#failure = error instanceof Error ? error : new HarnessContractError("socket");
    }
  }

  #throwFailure(): void {
    if (this.#failure !== undefined) throw this.#failure;
  }
}
