import { resolve } from "node:path";
import { z } from "zod";
import { canonicalRootSpelling } from "./anchored-fs";
import type { CommandContext } from "./types";

const toolArgsSchema = z.record(z.string(), z.unknown());

export type CommandContextResult =
  | { readonly ok: true; readonly value: CommandContext }
  | { readonly ok: false; readonly code: "command_unavailable" | "workdir_invalid" };

const commandFromRecord = (args: Readonly<Record<string, unknown>>): string | undefined => {
  const command = args["cmd"] ?? args["command"] ?? args["code"];
  return typeof command === "string" && command.length > 0 ? command : undefined;
};

export const commandFromArgs = (args: unknown): string | undefined => {
  const parsed = toolArgsSchema.safeParse(args);
  return parsed.success ? commandFromRecord(parsed.data) : undefined;
};

export const commandContextFromArgs = (
  input: { readonly tool: string; readonly sessionID: string },
  args: unknown,
  directory: string,
): CommandContextResult => {
  const parsed = toolArgsSchema.safeParse(args);
  if (!parsed.success) return { ok: false, code: "command_unavailable" };
  const command = commandFromRecord(parsed.data);
  if (!command) return { ok: false, code: "command_unavailable" };
  const workdir = parsed.data["workdir"];
  if (workdir !== undefined && typeof workdir !== "string") return { ok: false, code: "workdir_invalid" };
  const canonicalDirectory = canonicalRootSpelling(directory);
  if (!canonicalDirectory.ok) return { ok: false, code: "workdir_invalid" };
  const candidate = workdir ? resolve(canonicalDirectory.value.absolute, workdir) : canonicalDirectory.value.absolute;
  const cwd = canonicalRootSpelling(candidate);
  if (!cwd.ok) return { ok: false, code: "workdir_invalid" };
  return {
    ok: true,
    value: {
      sessionID: input.sessionID,
      tool: input.tool,
      command,
      cwd: cwd.value.absolute,
      args,
    },
  };
};

export const buildCommandContext = (
  input: { readonly tool: string; readonly sessionID: string },
  args: unknown,
  cwd: string,
): CommandContext | undefined => {
  const result = commandContextFromArgs(input, args, cwd);
  return result.ok ? result.value : undefined;
};
