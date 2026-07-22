import { createHash } from "node:crypto";
import { canonicalRootSpelling } from "./anchored-fs";
import { stableJsonStringify, toStableJsonValue, type JsonValue } from "./stable-json";
import type { CommandContext, ShellAnalysis } from "./types";

export type CommandEffect = {
  readonly parentSessionID: string;
  readonly canonicalCwd: string;
  readonly handledTool: string;
  readonly command: string;
  readonly args: JsonValue;
  readonly shellAnalysis: JsonValue;
};

export type CommandEffectResult =
  | {
      readonly ok: true;
      readonly effect: CommandEffect;
      readonly serialized: string;
      readonly sha256: string;
    }
  | { readonly ok: false; readonly code: "invalid_effect" };

export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export const createCommandEffect = (input: {
  readonly context: CommandContext;
  readonly analysis: ShellAnalysis;
}): CommandEffectResult => {
  const cwd = canonicalRootSpelling(input.context.cwd);
  const args = toStableJsonValue(input.context.args);
  const shellAnalysis = toStableJsonValue(input.analysis);
  if (!cwd.ok || cwd.value.absolute !== input.context.cwd || !args.ok || !shellAnalysis.ok) {
    return { ok: false, code: "invalid_effect" };
  }
  const effect: CommandEffect = Object.freeze({
    parentSessionID: input.context.sessionID,
    canonicalCwd: cwd.value.absolute,
    handledTool: input.context.tool,
    command: input.context.command,
    args: args.value,
    shellAnalysis: shellAnalysis.value,
  });
  const serialized = stableJsonStringify(effect);
  return serialized.ok
    ? { ok: true, effect, serialized: serialized.value, sha256: sha256Hex(serialized.value) }
    : { ok: false, code: "invalid_effect" };
};
