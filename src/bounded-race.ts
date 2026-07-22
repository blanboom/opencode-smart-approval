export type MonotonicDeadline = {
  readonly expiresAt: number;
  readonly now: () => number;
};

export type LateSettlement<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected" };

export type BoundedCallResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: "exhausted" | "timeout" | "rejected" };

export const createMonotonicDeadline = (
  timeoutMs: number,
  now: () => number = () => performance.now(),
): MonotonicDeadline => ({ expiresAt: now() + timeoutMs, now });

export const runBoundedCall = async <T>(_input: {
  readonly deadline: MonotonicDeadline;
  readonly timeoutMs: number;
  readonly operation: (signal: AbortSignal) => Promise<T>;
  readonly onLateSettlement?: (settlement: LateSettlement<T>) => void | Promise<void>;
}): Promise<BoundedCallResult<T>> => {
  const input = _input;
  const remaining = input.deadline.expiresAt - input.deadline.now();
  if (!(remaining > 0) || !(input.timeoutMs > 0)) return { ok: false, code: "exhausted" };
  const duration = Math.min(remaining, input.timeoutMs);
  const controller = new AbortController();
  let operation: Promise<T>;
  try {
    operation = input.operation(controller.signal);
  } catch (error) {
    if (error instanceof Error) return { ok: false, code: "rejected" };
    return { ok: false, code: "rejected" };
  }
  return new Promise<BoundedCallResult<T>>((resolve) => {
    let completed = false;
    const observeLate = (settlement: LateSettlement<T>): void => {
      if (!input.onLateSettlement) return;
      try {
        const observed = input.onLateSettlement(settlement);
        void Promise.resolve(observed).catch(() => undefined);
      } catch (error) {
        if (!(error instanceof Error)) return;
      }
    };
    const timer = setTimeout(() => {
      if (completed) return;
      completed = true;
      controller.abort();
      resolve({ ok: false, code: "timeout" });
    }, duration);
    void operation.then(
      (value) => {
        if (completed) {
          observeLate({ status: "fulfilled", value });
          return;
        }
        completed = true;
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      () => {
        if (completed) {
          observeLate({ status: "rejected" });
          return;
        }
        completed = true;
        clearTimeout(timer);
        resolve({ ok: false, code: "rejected" });
      },
    );
  });
};
