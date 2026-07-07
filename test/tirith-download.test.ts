import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { ensureTirithBinary, selectTirithAsset, tirithTargetForPlatform } from "../src/tirith-download";
import type { TirithDownloadClient } from "../src/types";

const tempDir = (): string => {
  return mkdtempSync(join(tmpdir(), "command-approval-test-"));
};

const tarGzWithFile = (name: string, content: Buffer): Buffer => {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000755\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136, "ascii");
  header.fill(" ", 148, 156);
  header.write("0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, content, padding, Buffer.alloc(1024)]));
};

const zipWithFile = (name: string, content: Buffer): Buffer => {
  const nameBuffer = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  const centralOffset = local.length + nameBuffer.length + content.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuffer.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBuffer, content, central, nameBuffer, eocd]);
};

describe("tirith auto download", () => {
  test("maps supported platforms to GitHub release assets", () => {
    expect(tirithTargetForPlatform({ platform: "darwin", arch: "arm64" })?.assetName).toBe(
      "tirith-aarch64-apple-darwin.tar.gz",
    );
    expect(tirithTargetForPlatform({ platform: "linux", arch: "x64" })?.assetName).toBe(
      "tirith-x86_64-unknown-linux-gnu.tar.gz",
    );
    expect(tirithTargetForPlatform({ platform: "linux", arch: "arm64", libc: "musl" })?.assetName).toBe(
      "tirith-aarch64-unknown-linux-musl.tar.gz",
    );
    expect(tirithTargetForPlatform({ platform: "linux", arch: "x64", libc: "musl" })).toBeUndefined();
    expect(tirithTargetForPlatform({ platform: "win32", arch: "x64" })?.assetName).toBe(
      "tirith-x86_64-pc-windows-msvc.zip",
    );
    expect(tirithTargetForPlatform({ platform: "win32", arch: "arm64" })).toBeUndefined();
    expect(tirithTargetForPlatform({ platform: "freebsd", arch: "x64" })).toBeUndefined();
  });

  test("selects the newest version release with the matching asset and checksum", () => {
    const target = tirithTargetForPlatform({ platform: "darwin", arch: "arm64" });
    if (!target) throw new Error("expected supported test target");
    const asset = selectTirithAsset(
      [
        {
          tagName: "threatdb-latest",
          assets: [{ name: "tirith-threatdb.dat", downloadUrl: "https://example.invalid/threatdb" }],
        },
        {
          tagName: "v1.2.3",
          assets: [
            { name: "checksums.txt", downloadUrl: "https://example.invalid/checksums" },
            { name: target.assetName, downloadUrl: "https://example.invalid/tirith" },
          ],
        },
      ],
      target,
    );
    expect(asset?.tagName).toBe("v1.2.3");
    expect(asset?.binary.downloadUrl).toBe("https://example.invalid/tirith");
  });

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
});
