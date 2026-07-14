import { get } from "node:https";

const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

export const downloadUrl = (
  url: string,
  maxBytes: number,
  deadline = Date.now() + DOWNLOAD_TIMEOUT_MS,
  redirects = 0,
): Promise<Buffer> => new Promise<Buffer>((resolve, reject) => {
  let settled = false;
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    reject(new Error("download timed out"));
    return;
  }
  const request = get(
    url,
    {
      headers: {
        "user-agent": "opencode-smart-approval",
        accept: "application/octet-stream, application/vnd.github+json",
      },
    },
    (response) => {
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        response.resume();
        reject(error);
      };
      const location = response.headers.location;
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location) {
        if (redirects >= MAX_REDIRECTS) {
          fail(new Error("too many redirects while downloading Tirith"));
          return;
        }
        settled = true;
        clearTimeout(timer);
        response.resume();
        resolve(downloadUrl(new URL(location, url).toString(), maxBytes, deadline, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        fail(new Error(`download failed with HTTP ${String(response.statusCode)}`));
        return;
      }
      const declared = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(declared) && declared > maxBytes) {
        fail(new Error(`download exceeds the ${String(maxBytes)} byte limit`));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > maxBytes) {
          fail(new Error(`download exceeds the ${String(maxBytes)} byte limit`));
          response.destroy();
          return;
        }
        chunks.push(buffer);
      });
      response.once("error", fail);
      response.once("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks, total));
      });
    },
  );
  const timer = setTimeout(() => {
    request.destroy(new Error("download timed out"));
  }, remaining);
  request.once("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(error);
  });
});
