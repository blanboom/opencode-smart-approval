import { stableJsonStringify } from "./stable-json";
import type { ConfirmationValues } from "./confirmation-renderer";
import { sha256Hex } from "./command-effect";

export type ConfirmationDisclosure = ConfirmationValues;

export const createConfirmationDisclosure = (
  values: ConfirmationValues,
): { readonly ok: true; readonly sha256: string } | { readonly ok: false } => {
  const serialized = stableJsonStringify({
    command: values.command,
    cwd: values.cwd,
    action: values.action,
    data: values.data,
    destination: values.destination,
    risk: values.risk,
  });
  return serialized.ok
    ? { ok: true, sha256: sha256Hex(serialized.value) }
    : { ok: false };
};
