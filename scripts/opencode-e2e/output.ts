import { HarnessContractError } from "./errors";

export type OutputSnapshot = {
  readonly text: string;
  readonly retainedBytes: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
};

export class BoundedOutput {
  readonly #chunks: Uint8Array[] = [];
  #retainedBytes = 0;
  #totalBytes = 0;

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new HarnessContractError("process");
  }

  append(chunk: string | Uint8Array): void {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    this.#totalBytes += bytes.byteLength;
    const available = this.limit - this.#retainedBytes;
    if (available < 1) return;
    const retained = bytes.slice(0, available);
    this.#chunks.push(retained);
    this.#retainedBytes += retained.byteLength;
  }

  snapshot(): OutputSnapshot {
    const joined = new Uint8Array(this.#retainedBytes);
    let offset = 0;
    for (const chunk of this.#chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return Object.freeze({
      text: new TextDecoder().decode(joined),
      retainedBytes: this.#retainedBytes,
      totalBytes: this.#totalBytes,
      truncated: this.#totalBytes > this.#retainedBytes,
    });
  }
}

export type StartupOrigin = { readonly origin: string; readonly port: number };

export const requireUniqueStartupOrigin = (stdout: string): StartupOrigin => {
  const prefix = "opencode server listening on ";
  const candidates = stdout.split(/\r?\n/u).filter((line) => line.startsWith(prefix));
  if (candidates.length !== 1) throw new HarnessContractError("startup");
  const match = /^opencode server listening on http:\/\/127\.0\.0\.1:([1-9][0-9]*)$/u.exec(candidates[0] ?? "");
  if (!match) throw new HarnessContractError("startup");
  const port = Number(match[1]);
  if (!Number.isSafeInteger(port) || port > 65_535) throw new HarnessContractError("startup");
  return Object.freeze({ origin: `http://127.0.0.1:${port}`, port });
};
