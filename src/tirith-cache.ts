import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { TirithTarget } from "./tirith-target";

const CACHE_METADATA_SCHEMA = z.object({
  version: z.literal(1),
  tagName: z.string().startsWith("v"),
  assetName: z.string().min(1),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  checkedAt: z.number().int().nonnegative(),
});

export type TirithCacheMetadata = z.infer<typeof CACHE_METADATA_SCHEMA>;

type StaleCacheCandidate = {
  readonly cached: TirithCacheMetadata | undefined;
  readonly binaryPath: string;
  readonly metadataPath: string;
  readonly target: TirithTarget;
};

export const sha256Buffer = (value: Buffer): string => createHash("sha256").update(value).digest("hex");

export const readVerifiedCacheMetadata = (
  binaryPath: string,
  metadataPath: string,
): TirithCacheMetadata | undefined => {
  if (!existsSync(binaryPath) || !existsSync(metadataPath)) return undefined;
  try {
    const parsed = CACHE_METADATA_SCHEMA.safeParse(JSON.parse(readFileSync(metadataPath, "utf8")));
    if (!parsed.success || sha256Buffer(readFileSync(binaryPath)) !== parsed.data.binarySha256) return undefined;
    return parsed.data;
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
};

const sameCacheProof = (left: TirithCacheMetadata, right: TirithCacheMetadata): boolean => (
  left.tagName === right.tagName
  && left.assetName === right.assetName
  && left.archiveSha256 === right.archiveSha256
  && left.binarySha256 === right.binarySha256
);

export const staleVerifiedTirithResult = (candidate: StaleCacheCandidate): {
  readonly kind: "ready";
  readonly path: string;
  readonly freshness: "stale_verified";
} | undefined => {
  if (!candidate.cached || candidate.cached.assetName !== candidate.target.assetName) return undefined;
  const reverified = readVerifiedCacheMetadata(candidate.binaryPath, candidate.metadataPath);
  if (!reverified || !sameCacheProof(candidate.cached, reverified)) return undefined;
  return { kind: "ready", path: candidate.binaryPath, freshness: "stale_verified" };
};

export const writeTirithCacheMetadata = (metadataPath: string, metadata: TirithCacheMetadata): void => {
  const tempPath = `${metadataPath}.${randomUUID()}.download`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600, flag: "wx" });
    if (existsSync(metadataPath)) unlinkSync(metadataPath);
    renameSync(tempPath, metadataPath);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
};
