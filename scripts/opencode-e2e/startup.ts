import { HarnessContractError } from "./errors";
import { z } from "zod";

export type StartupReceipt = {
  readonly origin: string;
  readonly port: number;
};

const HealthReceiptSchema = z.object({
  healthy: z.literal(true),
  version: z.literal("1.17.14"),
}).strict();

export const parseStartupReceipt = (stdout: string): StartupReceipt => {
  const candidates = stdout.split(/\r?\n/u).filter((line) => line.startsWith("opencode server listening on "));
  if (candidates.length !== 1) throw new HarnessContractError("startup");
  const match = /^opencode server listening on (http:\/\/127\.0\.0\.1:([1-9][0-9]*))$/u.exec(candidates[0] ?? "");
  if (!match) throw new HarnessContractError("startup");
  const port = Number(match[2]);
  if (!Number.isSafeInteger(port) || port > 65_535) throw new HarnessContractError("startup");
  return Object.freeze({ origin: match[1] ?? "", port });
};

export const parseHealthReceipt = (input: unknown): { readonly healthy: true; readonly version: "1.17.14" } => {
  const parsed = HealthReceiptSchema.safeParse(input);
  if (!parsed.success) throw new HarnessContractError("health");
  return Object.freeze(parsed.data);
};
