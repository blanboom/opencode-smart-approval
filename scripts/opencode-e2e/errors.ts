export const HARNESS_ERROR_CODES = [
  "not_implemented",
  "environment",
  "startup",
  "health",
  "provider_request",
  "provider_stream",
  "socket",
  "package_contract",
  "sdk_error",
  "sdk_malformed",
  "deadline",
  "binary_contract",
  "process",
] as const;

export type HarnessErrorCode = (typeof HARNESS_ERROR_CODES)[number];

export class HarnessContractError extends Error {
  readonly name = "HarnessContractError";

  constructor(readonly code: HarnessErrorCode) {
    super(code);
  }
}
