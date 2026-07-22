import { HarnessContractError } from "./errors";
import { deadlineSignal } from "./sdk";

export const SCENARIO_TIMEOUT_MS = 20_000;

type DeadlineClock = () => number;
type DeadlineSignalFactory = (milliseconds: number) => AbortSignal;

export type ScenarioDeadline = Readonly<{
  remainingMilliseconds: () => number;
  run: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
}>;

export const createScenarioDeadline = (input: Readonly<{
  readonly now?: DeadlineClock;
  readonly signalFactory?: DeadlineSignalFactory;
}> = {}): ScenarioDeadline => {
  const now = input.now ?? (() => performance.now());
  const signalFactory = input.signalFactory ?? deadlineSignal;
  const expiresAt = now() + SCENARIO_TIMEOUT_MS;

  const remainingMilliseconds = (): number => {
    const remaining = Math.floor(expiresAt - now());
    if (!Number.isSafeInteger(remaining) || remaining < 1) throw new HarnessContractError("deadline");
    return remaining;
  };
  const run = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const milliseconds = remainingMilliseconds();
    const signal = signalFactory(milliseconds);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(signal),
        new Promise<T>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new HarnessContractError("deadline")), milliseconds);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };

  return Object.freeze({ remainingMilliseconds, run });
};
