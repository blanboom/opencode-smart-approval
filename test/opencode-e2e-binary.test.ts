import { describe, expect, test } from "bun:test";
import { inspectLocalOpenCodeBinary, requireBinaryLockReceipts } from "../scripts/opencode-e2e/binary";

describe("pinned local OpenCode binary", () => {
  test("resolves the project binary and proves wrapper, platform, and string receipts", () => {
    // Given the frozen Todo 12 install in the current package root.
    const root = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");

    // When the pinned binary boundary is inspected without ambient PATH discovery.
    const receipt = inspectLocalOpenCodeBinary(root);

    // Then exact package identity, executable identity, and every used environment key are present.
    expect(receipt.wrapper).toEqual({
      name: "opencode-ai",
      version: "1.17.14",
      rawBin: "./bin/opencode.exe",
      canonicalBin: "bin/opencode.exe",
    });
    expect(receipt.platform).toEqual({ name: "opencode-darwin-arm64", version: "1.17.14" });
    expect(receipt.executable).toEndWith("/node_modules/opencode-ai/bin/opencode.exe");
    expect(receipt.executableSha256).toBe(receipt.platformSha256);
    expect(receipt.environmentKeys).toHaveLength(17);
  });

  test("rejects either missing pinned lock integrity", () => {
    // Given a lock fragment containing both exact receipts and variants with one removed.
    const wrapper = "sha512-UuWFOBtiYufHsvHtnn2/AASjDM8wW+kSkDnvAG2cbfSsIXU3wGG9nS9XSKvLelvZBigTi5DkqFl8Z0YKxMDifg==";
    const platform = "sha512-UGD7xl4E2rwdjrq+mLjoQK15T0179Iu3LeaCU+kYgprcFtLA9DRbB0nwgbXMaY/n78mlG1tAIrkyWyf2Pi6a9g==";

    // When lock receipt validation sees complete or drifted content.
    // Then only the exact pair passes.
    expect(() => requireBinaryLockReceipts(`${wrapper}\n${platform}`)).not.toThrow();
    expect(() => requireBinaryLockReceipts(platform)).toThrow("binary_contract");
    expect(() => requireBinaryLockReceipts(wrapper)).toThrow("binary_contract");
  });
});
