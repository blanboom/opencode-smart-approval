import { describe, expect, test } from "bun:test";
import { join } from "node:path";

type HookDriverResult = {
  readonly afterUserAllow: { readonly reviewerCount: number; readonly scans: string };
  readonly changedDirectoryProtectionError: string;
  readonly cpTrailingOptionProtectionError: string;
  readonly dashDirectoryProtectionError: string;
  readonly deniedError: string;
  readonly directoryDestinationProtectionError: string;
  readonly installTrailingOptionProtectionError: string;
  readonly reviewerCount: number;
  readonly reviewerObservedScan: boolean;
  readonly rsyncShortOptionProtectionError: string;
  readonly rsyncTrailingOptionProtectionError: string;
  readonly rsyncUnknownOptionProtectionError: string;
  readonly scannerBlockedError: string;
  readonly selfProtectionError: string;
  readonly tirithCommands: readonly string[];
};

describe("exported plugin hook", () => {
  test("observes the complete protection and decision pipeline through plugin.server", async () => {
    // Given the package's exported plugin surface and isolated scanner/reviewer doubles.
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "hook-driver.ts")], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });

    // When user allow, user deny, scanner allow/block, and config writes are exercised.
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const result = JSON.parse(stdout) as HookDriverResult;

    // Then each stage is terminal at its intended boundary and the scanner precedes the LLM.
    expect(exitCode, stderr).toBe(0);
    expect(result.afterUserAllow).toEqual({ reviewerCount: 0, scans: "" });
    expect(result.changedDirectoryProtectionError).toContain("approval configuration");
    expect(result.cpTrailingOptionProtectionError).toContain("approval configuration");
    expect(result.dashDirectoryProtectionError).toContain("approval configuration");
    expect(result.deniedError).toContain("matched deny[0]");
    expect(result.directoryDestinationProtectionError).toContain("approval configuration");
    expect(result.installTrailingOptionProtectionError).toContain("approval configuration");
    expect(result.reviewerCount).toBe(1);
    expect(result.reviewerObservedScan).toBe(true);
    expect(result.rsyncShortOptionProtectionError).toContain("approval configuration");
    expect(result.rsyncTrailingOptionProtectionError).toContain("approval configuration");
    expect(result.rsyncUnknownOptionProtectionError).toContain("approval configuration");
    expect(result.scannerBlockedError).toContain("fake scan");
    expect(result.selfProtectionError).toContain("approval configuration");
    expect(result.tirithCommands).toEqual(["scanner-allow", "scanner-block"]);
  });
});
