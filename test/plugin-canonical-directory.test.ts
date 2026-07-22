import { describe, expect, test } from "bun:test";
import { join } from "node:path";

type CanonicalDriverResult = {
  readonly canonical: string;
  readonly directories: readonly (string | undefined)[];
  readonly factoryDirectory: string | undefined;
  readonly lateDirectories: readonly (string | undefined)[];
  readonly lateMethods: readonly string[];
  readonly lateOutcome: string;
  readonly methods: readonly string[];
  readonly promptCwd: string | undefined;
  readonly runtimeDirectory: string | undefined;
};

const runVariant = async (variant: string): Promise<CanonicalDriverResult> => {
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "fixtures", "canonical-plugin-driver.ts"),
    variant,
  ], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  return JSON.parse(stdout) as CanonicalDriverResult;
};

describe("canonical plugin directory", () => {
  for (const variant of ["dot", "parent", "separators"] as const) {
    test(`reuses one canonical directory for the ${variant} spelling`, async () => {
      // Given the public plugin server receives a real noncanonical workspace spelling.
      const result = await runVariant(variant);

      // When transcript and reviewer lifecycle calls complete normally.
      expect(result.methods).toEqual(["messages", "agents", "create", "agents", "prompt", "delete"]);

      // Then every root call and the serialized command context share one byte-identical directory.
      expect(result.directories).toEqual(result.methods.map(() => result.canonical));
      expect(result.factoryDirectory).toBe(result.canonical);
      expect(result.runtimeDirectory).toBe(result.canonical);
      expect(result.promptCwd).toBe(result.canonical);
      expect(result.lateOutcome).toBe("deny");
      expect(result.lateMethods).toEqual(["agents", "create", "delete", "log"]);
      expect(result.lateDirectories).toEqual(result.lateMethods.map(() => result.canonical));
    });
  }
});
