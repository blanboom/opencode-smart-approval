import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { ensureTirithBinary, tirithTargetForPlatform, type TirithTarget } from "../src/tirith-download";
import { tarGzWithFile, tempDir } from "./tirith-test-helpers";

type VerifiedCache = {
  readonly directory: string;
  readonly target: TirithTarget;
  readonly binary: Buffer;
  readonly archive: Buffer;
  readonly digest: string;
  readonly binaryPath: string;
};

const installVerifiedCache = async (): Promise<VerifiedCache> => {
  const directory = tempDir();
  const target = tirithTargetForPlatform({ platform: "darwin", arch: "arm64" });
  if (!target) throw new Error("expected supported test target");
  const binary = Buffer.from("verified stale binary\n");
  const archive = tarGzWithFile(target.binaryName, binary);
  const digest = createHash("sha256").update(archive).digest("hex");
  const installed = await ensureTirithBinary({
    cacheRoot: directory,
    runtime: { platform: "darwin", arch: "arm64" },
    client: {
      listReleases: async () => [{
        tagName: "v1.2.3",
        assets: [
          { name: "checksums.txt", downloadUrl: "https://example.invalid/checksums" },
          { name: target.assetName, downloadUrl: "https://example.invalid/tirith" },
        ],
      }],
      download: async (url) => Buffer.from(url.endsWith("/checksums")
        ? `${digest}  ${target.assetName}\n`
        : archive),
    },
  });
  if (installed.kind !== "ready") throw new Error("expected initial Tirith binary");
  return { directory, target, binary, archive, digest, binaryPath: installed.path };
};

const staleOptions = (cache: VerifiedCache) => ({
  cacheRoot: cache.directory,
  runtime: { platform: "darwin", arch: "arm64" } as const,
  cacheMaxAgeMs: 0,
});

describe("verified stale Tirith cache", () => {
  test("reuses locally reverified bytes when release discovery is unavailable", async () => {
    // Given a cache installed from a checksum-verified release.
    const cache = await installVerifiedCache();

    // When the aged cache cannot refresh release metadata.
    const reused = await ensureTirithBinary({
      ...staleOptions(cache),
      client: {
        listReleases: async () => {
          throw new Error("offline");
        },
        download: async () => {
          throw new Error("unexpected download");
        },
      },
    });

    // Then the exact cached bytes are returned with degraded freshness evidence.
    expect(reused).toEqual({ kind: "ready", path: cache.binaryPath, freshness: "stale_verified" });
    expect(readFileSync(cache.binaryPath).toString("hex")).toBe(cache.binary.toString("hex"));
  });

  test("reuses locally reverified bytes when the same release checksum download is unavailable", async () => {
    // Given an aged verified cache whose release tag remains current upstream.
    const cache = await installVerifiedCache();

    // When downloading that release's checksum manifest fails.
    const reused = await ensureTirithBinary({
      ...staleOptions(cache),
      client: {
        listReleases: async () => [{
          tagName: "v1.2.3",
          assets: [
            { name: "checksums.txt", downloadUrl: "https://example.invalid/checksums" },
            { name: cache.target.assetName, downloadUrl: "https://example.invalid/tirith" },
          ],
        }],
        download: async () => {
          throw new Error("offline");
        },
      },
    });

    // Then degraded reuse is explicit and the cached bytes remain unchanged.
    expect(reused).toEqual({ kind: "ready", path: cache.binaryPath, freshness: "stale_verified" });
    expect(readFileSync(cache.binaryPath).toString("hex")).toBe(cache.binary.toString("hex"));
  });

  test("does not treat a malformed same-release refresh as an outage", async () => {
    // Given an aged verified cache and the same upstream release tag.
    const cache = await installVerifiedCache();

    // When checksum refresh parsing rejects malformed data.
    const result = ensureTirithBinary({
      ...staleOptions(cache),
      client: {
        listReleases: async () => [{
          tagName: "v1.2.3",
          assets: [
            { name: "checksums.txt", downloadUrl: "https://example.invalid/checksums" },
            { name: cache.target.assetName, downloadUrl: "https://example.invalid/tirith" },
          ],
        }],
        download: async () => {
          throw new SyntaxError("malformed checksum response");
        },
      },
    });

    // Then malformed upstream proof fails closed instead of reusing stale bytes.
    await expect(result).rejects.toThrow("malformed checksum response");
  });

  test("does not reuse a tampered cache during a refresh outage", async () => {
    // Given a verified cache whose binary no longer matches its metadata.
    const cache = await installVerifiedCache();
    writeFileSync(cache.binaryPath, "tampered\n");

    // When release discovery is unavailable.
    const result = ensureTirithBinary({
      ...staleOptions(cache),
      client: {
        listReleases: async () => {
          throw new Error("offline");
        },
        download: async () => Buffer.from("unused"),
      },
    });

    // Then the cache is rejected instead of executed.
    await expect(result).rejects.toThrow("offline");
  });

  test("does not reuse a cache with absent or malformed metadata", async () => {
    // Given two verified caches whose proof metadata becomes unavailable.
    const absent = await installVerifiedCache();
    const malformed = await installVerifiedCache();
    unlinkSync(`${absent.binaryPath}.metadata.json`);
    writeFileSync(`${malformed.binaryPath}.metadata.json`, "{malformed");
    const outageClient = {
      listReleases: async () => {
        throw new Error("offline");
      },
      download: async () => Buffer.from("unused"),
    };

    // When both aged caches attempt an offline refresh.
    const results = await Promise.allSettled([
      ensureTirithBinary({ ...staleOptions(absent), client: outageClient }),
      ensureTirithBinary({ ...staleOptions(malformed), client: outageClient }),
    ]);

    // Then neither unverified binary is returned.
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  });

  test("fails closed after upstream proves replacement or revocation", async () => {
    // Given verified aged caches and upstream states that replace or remove their asset.
    const replaced = await installVerifiedCache();
    const revoked = await installVerifiedCache();

    // When the replacement checksum refresh fails and the revoked asset is absent.
    const replacement = ensureTirithBinary({
      ...staleOptions(replaced),
      client: {
        listReleases: async () => [{
          tagName: "v1.2.4",
          assets: [
            { name: "checksums.txt", downloadUrl: "https://example.invalid/checksums" },
            { name: replaced.target.assetName, downloadUrl: "https://example.invalid/tirith" },
          ],
        }],
        download: async () => {
          throw new Error("replacement unavailable");
        },
      },
    });
    const revocation = await ensureTirithBinary({
      ...staleOptions(revoked),
      client: { listReleases: async () => [], download: async () => Buffer.from("unused") },
    });

    // Then neither upstream proof is overridden by stale reuse.
    await expect(replacement).rejects.toThrow("replacement unavailable");
    expect(revocation.kind).toBe("skipped");
  });

  test("fails closed on malformed or changed checksum proof", async () => {
    // Given verified aged caches with same-tag malformed and changed manifests.
    const malformed = await installVerifiedCache();
    const changed = await installVerifiedCache();
    const releases = (target: TirithTarget) => async () => [{
      tagName: "v1.2.3",
      assets: [
        { name: "checksums.txt", downloadUrl: "https://example.invalid/checksums" },
        { name: target.assetName, downloadUrl: "https://example.invalid/tirith" },
      ],
    }];

    // When one checksum is missing and the other proves different archive bytes.
    const replacementArchive = tarGzWithFile(changed.target.binaryName, Buffer.from("replacement\n"));
    const replacementDigest = createHash("sha256").update(replacementArchive).digest("hex");
    const results = await Promise.allSettled([
      ensureTirithBinary({
        ...staleOptions(malformed),
        client: { listReleases: releases(malformed.target), download: async () => Buffer.from("malformed") },
      }),
      ensureTirithBinary({
        ...staleOptions(changed),
        client: {
          listReleases: releases(changed.target),
          download: async (url) => {
            if (url.endsWith("/checksums")) return Buffer.from(`${replacementDigest}  ${changed.target.assetName}\n`);
            throw new Error("replacement archive unavailable");
          },
        },
      }),
    ]);

    // Then proof failures propagate instead of falling back to stale bytes.
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  });
});
