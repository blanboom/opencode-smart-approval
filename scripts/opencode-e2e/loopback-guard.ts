import { HarnessContractError } from "./errors";

const textDecoder = new TextDecoder();
const GUARD_PORT = 4_096;

export type TcpListenerOwnership = Readonly<{
  readonly pid: number;
  readonly fd: string;
  readonly port: number;
  readonly address: string;
}>;

export type RunningLoopbackGuard = Readonly<{
  readonly pid: number;
  readonly fd: string;
  readonly port: 4_096;
}>;

type GuardState = { readonly server: ReturnType<typeof Bun.serve>; closed: boolean };
const guardStates = new WeakMap<RunningLoopbackGuard, GuardState>();

const ownershipCommand = (pid: number, port: number): readonly string[] => Object.freeze([
  "/usr/sbin/lsof",
  "-nP",
  "-a",
  "-p",
  String(pid),
  `-iTCP:${String(port)}`,
  "-sTCP:LISTEN",
  "-FpcfnP",
  "-w",
]);

export const requireOwnedTcpListener = (pid: number, port: number): TcpListenerOwnership => {
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new HarnessContractError("socket");
  }
  const result = Bun.spawnSync({ cmd: [...ownershipCommand(pid, port)], stdout: "pipe", stderr: "pipe" });
  const stdout = textDecoder.decode(result.stdout);
  const stderr = textDecoder.decode(result.stderr);
  if (result.exitCode !== 0 || stderr.length !== 0) throw new HarnessContractError("socket");
  const lines = stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  const pids = lines.filter((line) => line.startsWith("p")).map((line) => line.slice(1));
  const fds = lines.filter((line) => line.startsWith("f")).map((line) => line.slice(1));
  const protocols = lines.filter((line) => line.startsWith("P")).map((line) => line.slice(1));
  const names = lines.filter((line) => line.startsWith("n")).map((line) => line.slice(1));
  const address = `127.0.0.1:${String(port)}`;
  if (
    pids.length !== 1 || pids[0] !== String(pid) ||
    fds.length !== 1 || !/^[1-9][0-9]*[a-z]?$/u.test(fds[0] ?? "") ||
    protocols.length !== 1 || protocols[0] !== "TCP" ||
    names.length !== 1 || names[0] !== address
  ) throw new HarnessContractError("socket");
  return Object.freeze({ pid, fd: fds[0] ?? "", port, address });
};

export const acquireLoopbackGuard = (): RunningLoopbackGuard => {
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ hostname: "127.0.0.1", port: GUARD_PORT, fetch: () => new Response("guard") });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new HarnessContractError("socket");
  }
  try {
    if (server.port !== GUARD_PORT) throw new HarnessContractError("socket");
    const ownership = requireOwnedTcpListener(process.pid, GUARD_PORT);
    const guard = Object.freeze({ pid: process.pid, fd: ownership.fd, port: GUARD_PORT });
    guardStates.set(guard, { server, closed: false });
    return guard;
  } catch (error) {
    void server.stop(true);
    throw error;
  }
};

export const requireLoopbackGuard = (guard: RunningLoopbackGuard): TcpListenerOwnership => {
  const state = guardStates.get(guard);
  if (!state || state.closed) throw new HarnessContractError("socket");
  const ownership = requireOwnedTcpListener(guard.pid, guard.port);
  if (ownership.fd !== guard.fd) throw new HarnessContractError("socket");
  return ownership;
};

export const requireFallbackOpenCodeListener = (
  guard: RunningLoopbackGuard,
  pid: number,
  port: number,
): TcpListenerOwnership => {
  requireLoopbackGuard(guard);
  if (port === guard.port) throw new HarnessContractError("socket");
  return requireOwnedTcpListener(pid, port);
};

export const closeLoopbackGuard = async (guard: RunningLoopbackGuard): Promise<void> => {
  const state = guardStates.get(guard);
  if (!state || state.closed) return;
  requireLoopbackGuard(guard);
  state.closed = true;
  await state.server.stop(true);
};
