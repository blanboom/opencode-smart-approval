import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { extractBinaryFromTarGz, extractBinaryFromZip } from "../src/archive";
import { ensureTirithBinary, MAX_TIRITH_ARCHIVE_BYTES, tirithTargetForPlatform } from "../src/tirith-download";
import type { TirithDownloadClient } from "../src/types";
import { tarGzWithFile, tempDir, zipWithFile } from "./tirith-test-helpers";

describe("tirith auto download", () => {
  test("downloads, verifies, extracts, and reuses Tirith in a temp cache", async () => {
    const directory = tempDir();
    const target = tirithTargetForPlatform({ platform: "darwin", arch: "arm64" });
    if (!target) throw new Error("expected supported test target");
    const binary = Buffer.from("#!/bin/sh\necho fake tirith\n");
    const archive = tarGzWithFile("tirith", binary);
    const digest = createHash("sha256").update(archive).digest("hex");
    let downloads = 0;
    const client: TirithDownloadClient = {
      listReleases: async () => [
        {
          tagName: "v1.2.3",
          assets: [
            { name: "checksums.txt", downloadUrl: "https://example.invalid/checksums" },
            { name: target.assetName, downloadUrl: "https://example.invalid/tirith" },
          ],
        },
      ],
      download: async (url) => {
        downloads += 1;
        return Buffer.from(url.endsWith("/checksums") ? `${digest}  ${target.assetName}\n` : archive);
      },
    };
    const first = await ensureTirithBinary({
      cacheRoot: directory,
      runtime: { platform: "darwin", arch: "arm64" },
      client,
    });
    expect(first.kind).toBe("ready");
    if (first.kind !== "ready") throw new Error("expected ready Tirith binary");
    expect(readFileSync(first.path, "utf8")).toBe(binary.toString());
    const second = await ensureTirithBinary({
      cacheRoot: directory,
      runtime: { platform: "darwin", arch: "arm64" },
      client: {
        listReleases: async () => {
          throw new Error("cache miss");
        },
        download: async () => {
          throw new Error("cache miss");
        },
      },
    });
    expect(second).toEqual(first);
    expect(downloads).toBe(2);
  });

  test("does not trust a prepopulated cache binary without verified metadata", async () => {
    const directory = tempDir();
    const target = tirithTargetForPlatform({ platform: "darwin", arch: "arm64" });
    if (!target) throw new Error("expected supported test target");
    const installDir = join(directory, target.cacheKey);
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, target.binaryName), "#!/bin/sh\necho attacker\n");
    chmodSync(join(installDir, target.binaryName), 0o755);
    const verified = Buffer.from("#!/bin/sh\necho verified\n");
    const archive = tarGzWithFile(target.binaryName, verified);
    const digest = createHash("sha256").update(archive).digest("hex");
    const result = await ensureTirithBinary({
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
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("expected ready Tirith binary");
    expect(readFileSync(result.path)).toEqual(verified);
  });

  test("skips unsupported platforms instead of failing closed", async () => {
    const result = await ensureTirithBinary({
      cacheRoot: tempDir(),
      runtime: { platform: "freebsd", arch: "arm64" },
      client: {
        listReleases: async () => {
          throw new Error("should not query releases for unsupported targets");
        },
        download: async () => {
          throw new Error("should not download for unsupported targets");
        },
      },
    });
    expect(result.kind).toBe("skipped");
  });

  test("downloads and extracts the Windows zip asset", async () => {
    const directory = tempDir();
    const target = tirithTargetForPlatform({ platform: "win32", arch: "x64" });
    if (!target) throw new Error("expected supported test target");
    const binary = Buffer.from("fake windows exe");
    const archive = zipWithFile("tirith.exe", binary);
    const digest = createHash("sha256").update(archive).digest("hex");
    const client: TirithDownloadClient = {
      listReleases: async () => [
        {
          tagName: "v1.2.3",
          assets: [
            { name: "checksums.txt", downloadUrl: "https://example.invalid/checksums" },
            { name: target.assetName, downloadUrl: "https://example.invalid/tirith" },
          ],
        },
      ],
      download: async (url) => {
        return Buffer.from(url.endsWith("/checksums") ? `${digest}  ${target.assetName}\n` : archive);
      },
    };
    const result = await ensureTirithBinary({
      cacheRoot: directory,
      runtime: { platform: "win32", arch: "x64" },
      client,
    });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("expected ready Tirith binary");
    expect(readFileSync(result.path)).toEqual(binary);
  });

  test("refreshes stale cache metadata and installs a newer upstream release", async () => {
    const directory = tempDir();
    const target = tirithTargetForPlatform({ platform: "darwin", arch: "arm64" });
    if (!target) throw new Error("expected supported test target");
    const install = async (tagName: string, content: string, cacheMaxAgeMs?: number) => {
      const binary = Buffer.from(content);
      const archive = tarGzWithFile(target.binaryName, binary);
      const digest = createHash("sha256").update(archive).digest("hex");
      return ensureTirithBinary({
        cacheRoot: directory,
        runtime: { platform: "darwin", arch: "arm64" },
        ...(cacheMaxAgeMs === undefined ? {} : { cacheMaxAgeMs }),
        client: {
          listReleases: async () => [{
            tagName,
            assets: [
              { name: "checksums.txt", downloadUrl: "https://example.invalid/checksums" },
              { name: target.assetName, downloadUrl: "https://example.invalid/tirith" },
            ],
          }],
          download: async (url, maxBytes) => {
            if (url.endsWith("/tirith")) expect(maxBytes).toBe(MAX_TIRITH_ARCHIVE_BYTES);
            return Buffer.from(url.endsWith("/checksums") ? `${digest}  ${target.assetName}\n` : archive);
          },
        },
      });
    };
    const first = await install("v1.2.3", "first\n");
    if (first.kind !== "ready") throw new Error("expected initial Tirith binary");
    const second = await install("v1.2.4", "second\n", 0);
    if (second.kind !== "ready") throw new Error("expected refreshed Tirith binary");
    expect(readFileSync(second.path, "utf8")).toBe("second\n");
    const metadata = JSON.parse(readFileSync(`${second.path}.metadata.json`, "utf8")) as Record<string, unknown>;
    expect(metadata["tagName"]).toBe("v1.2.4");
    expect(metadata["assetName"]).toBe(target.assetName);
    expect(metadata["archiveSha256"]).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("refreshes a same-version cache from upstream checksum metadata without downloading the archive", async () => {
    const directory = tempDir();
    const target = tirithTargetForPlatform({ platform: "darwin", arch: "arm64" });
    if (!target) throw new Error("expected supported test target");
    const binary = Buffer.from("binary\n");
    const archive = tarGzWithFile(target.binaryName, binary);
    const digest = createHash("sha256").update(archive).digest("hex");
    const releases = async () => [{
      tagName: "v1.2.3",
      assets: [
        { name: "checksums.txt", downloadUrl: "https://example.invalid/checksums" },
        { name: target.assetName, downloadUrl: "https://example.invalid/tirith" },
      ],
    }];
    const first = await ensureTirithBinary({
      cacheRoot: directory,
      runtime: { platform: "darwin", arch: "arm64" },
      client: {
        listReleases: releases,
        download: async (url) => Buffer.from(url.endsWith("/checksums") ? `${digest}  ${target.assetName}\n` : archive),
      },
    });
    if (first.kind !== "ready") throw new Error("expected initial Tirith binary");
    let archiveDownloads = 0;
    const refreshed = await ensureTirithBinary({
      cacheRoot: directory,
      runtime: { platform: "darwin", arch: "arm64" },
      cacheMaxAgeMs: 0,
      client: {
        listReleases: releases,
        download: async (url) => {
          if (url.endsWith("/tirith")) archiveDownloads += 1;
          return Buffer.from(`${digest}  ${target.assetName}\n`);
        },
      },
    });
    expect(refreshed).toEqual(first);
    expect(archiveDownloads).toBe(0);
  });

  test("rejects malformed tar and zip entry bounds before extraction", () => {
    const tar = gunzipSync(tarGzWithFile("tirith", Buffer.from("tiny")));
    tar.write("77777777777\0", 124, "ascii");
    expect(() => extractBinaryFromTarGz(gzipSync(tar), "tirith")).toThrow("tar entry is outside");

    const zip = zipWithFile("tirith.exe", Buffer.from("tiny"));
    const eocd = zip.length - 22;
    const centralOffset = zip.readUInt32LE(eocd + 16);
    zip.writeUInt32LE(1024, centralOffset + 24);
    expect(() => extractBinaryFromZip(zip, "tirith.exe")).toThrow("size does not match");
  });
});
