import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { extractBinaryFromTarGz, extractBinaryFromZip } from "./archive";
import type { RuntimePlatform, TirithDownloadClient, TirithRelease, TirithReleaseAsset } from "./types";

const RELEASES_URL = "https://api.github.com/repos/sheeki03/tirith/releases?per_page=20";
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

const GITHUB_RELEASE_SCHEMA = z.object({
  tag_name: z.string(),
  assets: z.array(
    z.object({
      name: z.string(),
      browser_download_url: z.string().url(),
    }),
  ),
});

const GITHUB_RELEASES_SCHEMA = z.array(GITHUB_RELEASE_SCHEMA);

const PROCESS_REPORT_SCHEMA = z
  .object({
    header: z
      .object({
        glibcVersionRuntime: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

export type TirithTarget = {
  readonly assetName: string;
  readonly binaryName: string;
  readonly cacheKey: string;
  readonly archiveType: "tar.gz" | "zip";
};

export type SelectedTirithAsset = {
  readonly tagName: string;
  readonly binary: TirithReleaseAsset;
  readonly checksums: TirithReleaseAsset;
};

export type TirithBinaryResult =
  | {
      readonly kind: "ready";
      readonly path: string;
    }
  | {
      readonly kind: "skipped";
      readonly reason: string;
    };

export type TirithInstallOptions = {
  readonly cacheRoot?: string;
  readonly runtime?: RuntimePlatform;
  readonly client?: TirithDownloadClient;
};

const currentRuntime = (): RuntimePlatform => ({
  platform: process.platform,
  arch: process.arch,
  ...(process.platform === "linux" ? { libc: currentLinuxLibc() } : {}),
});

const defaultCacheRoot = (): string => {
  return join(tmpdir(), "opencode-smart-approval", "tirith");
};

const currentLinuxLibc = (): "glibc" | "musl" => {
  const report = PROCESS_REPORT_SCHEMA.safeParse(process.report?.getReport());
  const glibcVersion = report.success ? report.data.header?.glibcVersionRuntime : undefined;
  return typeof glibcVersion === "string" && glibcVersion.length > 0 ? "glibc" : "musl";
};

export const tirithTargetForPlatform = (runtime: RuntimePlatform): TirithTarget | undefined => {
  switch (runtime.platform) {
    case "darwin":
      if (runtime.arch === "arm64") {
        return {
          assetName: "tirith-aarch64-apple-darwin.tar.gz",
          binaryName: "tirith",
          cacheKey: "darwin-arm64",
          archiveType: "tar.gz",
        };
      }
      if (runtime.arch === "x64") {
        return {
          assetName: "tirith-x86_64-apple-darwin.tar.gz",
          binaryName: "tirith",
          cacheKey: "darwin-x64",
          archiveType: "tar.gz",
        };
      }
      return undefined;
    case "linux":
      if (runtime.arch === "arm64" && runtime.libc === "musl") {
        return {
          assetName: "tirith-aarch64-unknown-linux-musl.tar.gz",
          binaryName: "tirith",
          cacheKey: "linux-arm64-musl",
          archiveType: "tar.gz",
        };
      }
      if (runtime.arch === "arm64") {
        return {
          assetName: "tirith-aarch64-unknown-linux-gnu.tar.gz",
          binaryName: "tirith",
          cacheKey: "linux-arm64-glibc",
          archiveType: "tar.gz",
        };
      }
      if (runtime.arch === "x64" && runtime.libc === "musl") {
        return undefined;
      }
      if (runtime.arch === "x64") {
        return {
          assetName: "tirith-x86_64-unknown-linux-gnu.tar.gz",
          binaryName: "tirith",
          cacheKey: "linux-x64-glibc",
          archiveType: "tar.gz",
        };
      }
      return undefined;
    case "win32":
      if (runtime.arch === "x64") {
        return {
          assetName: "tirith-x86_64-pc-windows-msvc.zip",
          binaryName: "tirith.exe",
          cacheKey: "win32-x64",
          archiveType: "zip",
        };
      }
      return undefined;
    default:
      return undefined;
  }
};

export const selectTirithAsset = (
  releases: readonly TirithRelease[],
  target: TirithTarget,
): SelectedTirithAsset | undefined => {
  for (const release of releases) {
    if (!release.tagName.startsWith("v")) continue;
    const binary = release.assets.find((asset) => asset.name === target.assetName);
    const checksums = release.assets.find((asset) => asset.name === "checksums.txt");
    if (binary && checksums) return { tagName: release.tagName, binary, checksums };
  }
  return undefined;
};

const downloadUrl = (url: string, redirects: number = 0): Promise<Buffer> => {
  return new Promise<Buffer>((resolve, reject) => {
    const request = get(
      url,
      {
        headers: {
          "user-agent": "opencode-smart-approval",
          accept: "application/octet-stream, application/vnd.github+json",
        },
      },
      (response) => {
        const location = response.headers.location;
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location) {
          if (redirects >= MAX_REDIRECTS) {
            reject(new Error("too many redirects while downloading Tirith"));
            return;
          }
          const redirected = new URL(location, url).toString();
          resolve(downloadUrl(redirected, redirects + 1));
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`download failed with HTTP ${String(response.statusCode)}`));
          return;
        }
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.once("end", () => {
          resolve(Buffer.concat(chunks));
        });
      },
    );
    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(new Error("download timed out"));
    });
    request.once("error", reject);
  });
};

const githubClient: TirithDownloadClient = {
  listReleases: async () => {
    const body = await downloadUrl(RELEASES_URL);
    const parsed = GITHUB_RELEASES_SCHEMA.parse(JSON.parse(body.toString("utf8")));
    return parsed.map((release) => ({
      tagName: release.tag_name,
      assets: release.assets.map((asset) => ({
        name: asset.name,
        downloadUrl: asset.browser_download_url,
      })),
    }));
  },
  download: downloadUrl,
};

const expectedChecksum = (checksums: string, assetName: string): string | undefined => {
  for (const line of checksums.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    const digest = fields[0];
    const name = fields[1];
    if (digest && name === assetName) return digest.toLowerCase();
  }
  return undefined;
};

const verifyChecksum = (archive: Buffer, checksums: string, assetName: string): void => {
  const expected = expectedChecksum(checksums, assetName);
  if (!expected) throw new Error(`checksum not found for ${assetName}`);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) throw new Error(`checksum mismatch for ${assetName}`);
};

const extractBinary = (archive: Buffer, target: TirithTarget): Buffer => {
  switch (target.archiveType) {
    case "tar.gz":
      return extractBinaryFromTarGz(archive, target.binaryName);
    case "zip":
      return extractBinaryFromZip(archive, target.binaryName);
  }
};

export const ensureTirithBinary = async (options: TirithInstallOptions = {}): Promise<TirithBinaryResult> => {
  const runtime = options.runtime ?? currentRuntime();
  const target = tirithTargetForPlatform(runtime);
  if (!target) {
    return { kind: "skipped", reason: `unsupported platform ${runtime.platform}/${runtime.arch}` };
  }
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot();
  const installDir = join(cacheRoot, target.cacheKey);
  const binaryPath = join(installDir, target.binaryName);
  if (existsSync(binaryPath)) {
    return { kind: "ready", path: binaryPath };
  }
  const client = options.client ?? githubClient;
  const selected = selectTirithAsset(await client.listReleases(), target);
  if (!selected) {
    return { kind: "skipped", reason: `no Tirith release asset for ${target.assetName}` };
  }
  const archive = await client.download(selected.binary.downloadUrl);
  const checksums = await client.download(selected.checksums.downloadUrl);
  verifyChecksum(archive, checksums.toString("utf8"), target.assetName);
  const binary = extractBinary(archive, target);
  mkdirSync(installDir, { recursive: true });
  const tempPath = join(installDir, `${target.binaryName}.download`);
  writeFileSync(tempPath, binary, { mode: 0o755 });
  chmodSync(tempPath, 0o755);
  renameSync(tempPath, binaryPath);
  return { kind: "ready", path: binaryPath };
};
