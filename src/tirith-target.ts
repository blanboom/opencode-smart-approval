import type { RuntimePlatform } from "./types";

export type TirithTarget = {
  readonly assetName: string;
  readonly binaryName: string;
  readonly cacheKey: string;
  readonly archiveType: "tar.gz" | "zip";
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
      if (runtime.arch === "x64" && runtime.libc === "musl") return undefined;
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
