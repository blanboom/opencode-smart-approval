import { HarnessContractError } from "./errors";

export type TerminationPlan = {
  readonly term: readonly number[];
  readonly kill: readonly number[];
};

export const buildTerminationPlan = (
  observedPids: readonly number[],
  liveAfterTerm: readonly number[],
): TerminationPlan => {
  const validatePid = (pid: number): void => {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new HarnessContractError("process");
  };
  observedPids.forEach(validatePid);
  liveAfterTerm.forEach(validatePid);
  const term = [...new Set(observedPids)];
  const owned = new Set(term);
  const kill = [...new Set(liveAfterTerm)];
  if (kill.some((pid) => !owned.has(pid))) throw new HarnessContractError("process");
  return Object.freeze({ term: Object.freeze(term), kill: Object.freeze(kill) });
};
