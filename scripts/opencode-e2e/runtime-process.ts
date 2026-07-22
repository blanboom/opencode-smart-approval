import { HarnessContractError } from "./errors";
import { createConnection } from "node:net";
import { BoundedOutput, requireUniqueStartupOrigin, type OutputSnapshot, type StartupOrigin } from "./output";
import {
  requireFallbackOpenCodeListener,
  type RunningLoopbackGuard,
  type TcpListenerOwnership,
} from "./loopback-guard";
import { buildLsofFilesCommand, parseLsofExit } from "./sampler";
import { parseHealthReceipt } from "./startup";

const OUTPUT_LIMIT = 65_536;

export type ManagedOpenCode = {
  readonly pid: number;
  readonly command: readonly string[];
  readonly origin: string;
  readonly port: number;
  readonly listener: TcpListenerOwnership;
  readonly stdout: BoundedOutput;
  readonly stderr: BoundedOutput;
  readonly exited: Promise<number>;
  readonly stdoutDone: Promise<void>;
  readonly stderrDone: Promise<void>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
};

export type StoppedOpenCode = {
  readonly exitCode: number;
  readonly signals: readonly ("SIGTERM" | "SIGKILL")[];
  readonly stdout: OutputSnapshot;
  readonly stderr: OutputSnapshot;
  readonly portClosed: true;
  readonly fdsGone: true;
};

const pump = async (stream: ReadableStream<Uint8Array>, capture: BoundedOutput): Promise<void> => {
  const reader = stream.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      capture.append(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
};

const waitForStartup = async (
  stdout: BoundedOutput,
  exitedState: () => number | undefined,
): Promise<StartupOrigin> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const text = stdout.snapshot().text;
    if (text.includes("opencode server listening on ")) return requireUniqueStartupOrigin(text);
    if (exitedState() !== undefined) throw new HarnessContractError("process");
    await Bun.sleep(25);
  }
  throw new HarnessContractError("startup");
};

const waitForHealth = async (origin: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/global/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        parseHealthReceipt(await response.json());
        return;
      }
    } catch (error) {
      if (error instanceof HarnessContractError) throw error;
    }
    await Bun.sleep(100);
  }
  throw new HarnessContractError("health");
};

const waitExit = async (exited: Promise<number>, milliseconds: number): Promise<number | undefined> => Promise.race([
  exited,
  Bun.sleep(milliseconds).then(() => undefined),
]);

export const isTcpPortOpen = async (port: number): Promise<boolean> => {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new HarnessContractError("socket");
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (open: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
};

export const waitForPortClosure = async (port: number, milliseconds: number): Promise<true> => {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 10_000) {
    throw new HarnessContractError("socket");
  }
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (!(await isTcpPortOpen(port))) return true;
    await Bun.sleep(50);
  }
  throw new HarnessContractError("socket");
};

const requireProcessFdsGone = (pid: number): true => {
  const result = Bun.spawnSync({ cmd: [...buildLsofFilesCommand(pid)], stdout: "pipe", stderr: "pipe" });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (parseLsofExit(result.exitCode, stdout, stderr) !== "") throw new HarnessContractError("process");
  return true;
};

export const startOpenCode = async (input: {
  readonly executable: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly guard: RunningLoopbackGuard;
}): Promise<ManagedOpenCode> => {
  const command = Object.freeze([input.executable, "serve", "--hostname=127.0.0.1", "--port=0", "--mdns=false"]);
  const child = Bun.spawn({ cmd: [...command], cwd: input.cwd, env: { ...input.environment }, stdout: "pipe", stderr: "pipe" });
  const stdout = new BoundedOutput(OUTPUT_LIMIT);
  const stderr = new BoundedOutput(OUTPUT_LIMIT);
  const stdoutDone = pump(child.stdout, stdout);
  const stderrDone = pump(child.stderr, stderr);
  let exitCode: number | undefined;
  const exited = child.exited.then((code) => {
    exitCode = code;
    return code;
  });
  let startup: StartupOrigin;
  try {
    startup = await waitForStartup(stdout, () => exitCode);
    await waitForHealth(startup.origin);
    const listener = requireFallbackOpenCodeListener(input.guard, child.pid, startup.port);
    return {
      pid: child.pid,
      command,
      origin: startup.origin,
      port: startup.port,
      listener,
      stdout,
      stderr,
      exited,
      stdoutDone,
      stderrDone,
      kill: (signal) => { child.kill(signal); },
    };
  } catch (error) {
    child.kill("SIGTERM");
    if (await waitExit(exited, 5_000) === undefined) {
      child.kill("SIGKILL");
      await waitExit(exited, 2_000);
    }
    await Promise.all([stdoutDone, stderrDone]);
    throw error;
  }
};

export const stopOpenCode = async (managed: ManagedOpenCode): Promise<StoppedOpenCode> => {
  const signals: ("SIGTERM" | "SIGKILL")[] = ["SIGTERM"];
  managed.kill("SIGTERM");
  let exitCode = await waitExit(managed.exited, 5_000);
  if (exitCode === undefined) {
    signals.push("SIGKILL");
    managed.kill("SIGKILL");
    exitCode = await waitExit(managed.exited, 2_000);
  }
  if (exitCode === undefined) throw new HarnessContractError("process");
  await Promise.all([managed.stdoutDone, managed.stderrDone]);
  requireUniqueStartupOrigin(managed.stdout.snapshot().text);
  const portClosed = await waitForPortClosure(managed.port, 5_000);
  const fdsGone = requireProcessFdsGone(managed.pid);
  return Object.freeze({
    exitCode,
    signals: Object.freeze(signals),
    stdout: managed.stdout.snapshot(),
    stderr: managed.stderr.snapshot(),
    portClosed,
    fdsGone,
  });
};
