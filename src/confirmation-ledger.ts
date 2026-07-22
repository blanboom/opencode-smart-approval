export const MAX_CONFIRMATION_REDACTION_HASHES = 64;
export const CONFIRMATION_REDACTION_TTL_MS = 24 * 60 * 60 * 1_000;

export type PendingConfirmation = {
  readonly parentSessionID: string;
  readonly canonicalCwd: string;
  readonly effectSha256: string;
  readonly disclosureSha256: string;
  readonly tokenHash: Buffer;
  readonly generation: number;
  readonly boundary: { readonly messageID: string; readonly created: number };
  readonly issuedAt: number;
  readonly expiresAt: number;
};

type HistoryEntry = { readonly hash: Buffer; readonly expiresAt: number };

export type ConfirmationLedger = ReturnType<typeof createConfirmationLedger>;

export const createConfirmationLedger = () => {
  const pending = new Map<string, PendingConfirmation>();
  const generations = new Map<string, number>();
  const histories = new Map<string, HistoryEntry[]>();
  const locks = new Map<string, Promise<void>>();

  const deletePending = (sessionID: string): void => {
    const current = pending.get(sessionID);
    current?.tokenHash.fill(0);
    pending.delete(sessionID);
  };
  const prune = (sessionID: string, now: number): HistoryEntry[] => {
    const current = histories.get(sessionID) ?? [];
    const retained: HistoryEntry[] = [];
    for (const entry of current) {
      if (entry.expiresAt > now) retained.push(entry);
      else entry.hash.fill(0);
    }
    if (retained.length === 0) histories.delete(sessionID);
    else histories.set(sessionID, retained);
    return retained;
  };
  const runLocked = async <T>(sessionID: string, operation: () => Promise<T>): Promise<T> => {
    const previous = locks.get(sessionID) ?? Promise.resolve();
    let unlock = (): void => undefined;
    const current = new Promise<void>((resolve) => { unlock = resolve; });
    locks.set(sessionID, current);
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
      if (locks.get(sessionID) === current) locks.delete(sessionID);
    }
  };
  const remember = (sessionID: string, hash: Uint8Array, now: number): void => {
    const current = prune(sessionID, now);
    current.push({ hash: Buffer.from(hash), expiresAt: now + CONFIRMATION_REDACTION_TTL_MS });
    while (current.length > MAX_CONFIRMATION_REDACTION_HASHES) current.shift()?.hash.fill(0);
    histories.set(sessionID, current);
  };
  const clearSession = (sessionID: string): void => {
    deletePending(sessionID);
    for (const entry of histories.get(sessionID) ?? []) entry.hash.fill(0);
    histories.delete(sessionID);
    generations.delete(sessionID);
  };
  return Object.freeze({
    runLocked,
    pending: (sessionID: string) => pending.get(sessionID),
    setPending: (value: PendingConfirmation) => {
      deletePending(value.parentSessionID);
      pending.set(value.parentSessionID, value);
    },
    deletePending,
    nextGeneration: (sessionID: string) => {
      const generation = (generations.get(sessionID) ?? 0) + 1;
      generations.set(sessionID, generation);
      return generation;
    },
    remember,
    hashes: (sessionID: string, now: number): readonly Uint8Array[] => prune(sessionID, now).map((entry) => entry.hash),
    clearSession,
    dispose: async () => {
      await Promise.all([...locks.values()]);
      for (const sessionID of new Set([...pending.keys(), ...histories.keys()])) clearSession(sessionID);
      locks.clear();
    },
  });
};
