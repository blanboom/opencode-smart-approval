import { describe, expect, test } from "bun:test";
import { join } from "node:path";

type ReviewerDriverResult = {
  readonly configuredRetryCount: number;
  readonly malformedCallCount: number;
  readonly malformedOutcome: string;
  readonly malformedReasons: readonly string[];
  readonly noRetryCallCount: number;
  readonly noRetryOutcome: string;
  readonly noRetryReasons: readonly string[];
};

describe("AI SDK reviewer", () => {
  test("passes retry configuration and handles malformed output without leaking module mocks", async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "reviewer-driver.ts")], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const result = JSON.parse(stdout) as ReviewerDriverResult;

    expect(exitCode, stderr).toBe(0);
    expect(result.configuredRetryCount).toBe(5);
    expect(result.malformedOutcome).toBe("deny");
    expect(result.malformedReasons).toEqual(["retry produced a complete decision"]);
    expect(result.malformedCallCount).toBe(2);
    expect(result.noRetryOutcome).toBe("deny");
    expect(result.noRetryReasons[0]).toContain("reviewer failed");
    expect(result.noRetryCallCount).toBe(1);
  });
});
