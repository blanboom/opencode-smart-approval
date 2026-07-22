import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { extractBinaryFromTarGz, extractBinaryFromZip } from "./archive";
import { downloadUrl } from "./bounded-download";
import {
  readVerifiedCacheMetadata,
  sha256Buffer,
  staleVerifiedTirithResult,
  writeTirithCacheMetadata,
  type TirithCacheMetadata,
} from "./tirith-cache";
import { tirithTargetForPlatform, type TirithTarget } from "./tirith-target";
import type { RuntimePlatform, TirithDownloadClient, TirithRelease, TirithReleaseAsset } from "./types";

export { tirithTargetForPlatform, type TirithTarget } from "./tirith-target";

const RELEASES_URL = "https://api.github.com/repos/sheeki03/tirith/releases?per_page=20";
export const MAX_TIRITH_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_RELEASES_BYTES = 2 * 1024 * 1024;
const MAX_CHECKSUMS_BYTES = 1024 * 1024;
const DEFAULT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

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

export type SelectedTirithAsset = {
  readonly tagName: string;
  readonly binary: TirithReleaseAsset;
  readonly checksums: TirithReleaseAsset;
};

export type TirithBinaryResult =
  | {
      readonly kind: "ready";
      readonly path: string;
      readonly freshness: "current" | "stale_verified";
    }
  | {
      readonly kind: "skipped";
      readonly reason: string;
    };

export type TirithInstallOptions = {
  readonly cacheRoot?: string;
  readonly runtime?: RuntimePlatform;
  readonly client?: TirithDownloadClient;
  readonly cacheMaxAgeMs?: number;
};

const currentRuntime = (): RuntimePlatform => ({
  platform: process.platform,
  arch: process.arch,
  ...(process.platform === "linux" ? { libc: currentLinuxLibc() } : {}),
});

const defaultCacheRoot = (): string => {
  const configured = process.env["XDG_CACHE_HOME"] || process.env["LOCALAPPDATA"];
  if (configured) return join(configured, "opencode-smart-approval", "tirith");
  return process.platform === "darwin"
    ? join(homedir(), "Library", "Caches", "opencode-smart-approval", "tirith")
    : join(homedir(), ".cache", "opencode-smart-approval", "tirith");
};

const currentLinuxLibc = (): "glibc" | "musl" => {
  const report = PROCESS_REPORT_SCHEMA.safeParse(process.report?.getReport());
  const glibcVersion = report.success ? report.data.header?.glibcVersionRuntime : undefined;
  return typeof glibcVersion === "string" && glibcVersion.length > 0 ? "glibc" : "musl";
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

const githubClient: TirithDownloadClient = {
  listReleases: async () => {
    const body = await downloadUrl(RELEASES_URL, MAX_RELEASES_BYTES);
    const parsed = GITHUB_RELEASES_SCHEMA.parse(JSON.parse(body.toString("utf8")));
    return parsed.map((release) => ({
      tagName: release.tag_name,
      assets: release.assets.map((asset) => ({
        name: asset.name,
        downloadUrl: asset.browser_download_url,
      })),
    }));
  },
  download: (url, maxBytes = MAX_TIRITH_ARCHIVE_BYTES) => downloadUrl(url, maxBytes),
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

const requireSize = (value: Buffer, maximum: number, label: string): void => {
  if (value.length > maximum) throw new Error(`${label} exceeds the ${String(maximum)} byte limit`);
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
  const metadataPath = `${binaryPath}.metadata.json`;
  const cached = readVerifiedCacheMetadata(binaryPath, metadataPath);
  const now = Date.now();
  const maxAge = Math.max(0, options.cacheMaxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS);
  const cacheAge = cached ? now - cached.checkedAt : Number.POSITIVE_INFINITY;
  if (cached && cached.assetName === target.assetName && cacheAge >= 0 && cacheAge < maxAge) {
    return { kind: "ready", path: binaryPath, freshness: "current" };
  }
  const client = options.client ?? githubClient;
  let releases: readonly TirithRelease[];
  try {
    releases = await client.listReleases();
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) throw error;
    const stale = staleVerifiedTirithResult({ cached, binaryPath, metadataPath, target });
    if (stale) return stale;
    throw error;
  }
  const selected = selectTirithAsset(releases, target);
  if (!selected) {
    return { kind: "skipped", reason: `no Tirith release asset for ${target.assetName}` };
  }
  let checksums: Buffer;
  try {
    checksums = await client.download(selected.checksums.downloadUrl, MAX_CHECKSUMS_BYTES);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) throw error;
    const upstreamMatchesCache = cached?.tagName === selected.tagName;
    const stale = upstreamMatchesCache
      ? staleVerifiedTirithResult({ cached, binaryPath, metadataPath, target })
      : undefined;
    if (stale) return stale;
    throw error;
  }
  requireSize(checksums, MAX_CHECKSUMS_BYTES, "Tirith checksum manifest");
  const archiveSha256 = expectedChecksum(checksums.toString("utf8"), target.assetName);
  if (!archiveSha256) throw new Error(`checksum not found for ${target.assetName}`);
  if (cached && cached.assetName === target.assetName && cached.tagName === selected.tagName && cached.archiveSha256 === archiveSha256) {
    writeTirithCacheMetadata(metadataPath, { ...cached, checkedAt: now });
    return { kind: "ready", path: binaryPath, freshness: "current" };
  }
  const archive = await client.download(selected.binary.downloadUrl, MAX_TIRITH_ARCHIVE_BYTES);
  requireSize(archive, MAX_TIRITH_ARCHIVE_BYTES, "Tirith archive");
  verifyChecksum(archive, checksums.toString("utf8"), target.assetName);
  const binary = extractBinary(archive, target);
  mkdirSync(installDir, { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  const tempPath = join(installDir, `${target.binaryName}.${nonce}.download`);
  const tempMetadataPath = `${tempPath}.metadata.json`;
  const metadata: TirithCacheMetadata = {
    version: 1,
    tagName: selected.tagName,
    assetName: target.assetName,
    archiveSha256,
    binarySha256: sha256Buffer(binary),
    checkedAt: now,
  };
  try {
    writeFileSync(tempPath, binary, { mode: 0o755, flag: "wx" });
    chmodSync(tempPath, 0o755);
    writeFileSync(tempMetadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600, flag: "wx" });
    if (existsSync(binaryPath)) unlinkSync(binaryPath);
    if (existsSync(metadataPath)) unlinkSync(metadataPath);
    renameSync(tempPath, binaryPath);
    renameSync(tempMetadataPath, metadataPath);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    if (existsSync(tempMetadataPath)) unlinkSync(tempMetadataPath);
  }
  return { kind: "ready", path: binaryPath, freshness: "current" };
};
