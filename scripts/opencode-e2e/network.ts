import { HarnessContractError } from "./errors";

export type SocketReceipt = {
  readonly pid: number;
  readonly protocol: "TCP" | "UDP";
  readonly name: string;
};

export const parseLsofSockets = (stdout: string, pid: number): readonly SocketReceipt[] => {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new HarnessContractError("socket");
  const receipts: SocketReceipt[] = [];
  for (const line of stdout.split(/\r?\n/u).filter((candidate) => candidate.length > 0)) {
    if (line.startsWith("COMMAND ")) continue;
    const match = /^\S+\s+([1-9][0-9]*)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(TCP|UDP)\s+(.+)$/u.exec(line);
    if (!match || Number(match[1]) !== pid) throw new HarnessContractError("socket");
    const protocol = match[2];
    const name = match[3];
    if ((protocol !== "TCP" && protocol !== "UDP") || name === undefined) throw new HarnessContractError("socket");
    receipts.push(Object.freeze({ pid, protocol, name }));
  }
  return Object.freeze(receipts);
};

export const requireLoopbackSockets = (sockets: readonly SocketReceipt[]): void => {
  for (const socket of sockets) {
    const address = socket.name.replace(/ \([^)]*\)$/u, "");
    const endpoints = address.split("->");
    if (endpoints.some((endpoint) => !/^127\.0\.0\.1:[1-9][0-9]*$/u.test(endpoint))) {
      throw new HarnessContractError("socket");
    }
  }
};
