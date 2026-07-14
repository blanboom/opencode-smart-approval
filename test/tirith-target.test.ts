import { describe, expect, test } from "bun:test";
import { selectTirithAsset, tirithTargetForPlatform } from "../src/tirith-download";

describe("tirith release targets", () => {
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
});
