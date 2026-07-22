import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { shellParserAssetPaths } from "../src/shell-parser";

const expectedGrammarHash = "8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a";
const packageRoot = join(import.meta.dir, "..");
const packageContractSchema = z.object({
  version: z.string(),
  description: z.string(),
  main: z.string(),
  exports: z.object({ ".": z.string() }).strict(),
  files: z.array(z.string()),
  scripts: z.record(z.string(), z.string()),
  dependencies: z.record(z.string(), z.string()),
});

const packageContract = () => packageContractSchema.parse(
  JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")),
);

describe("published shell parser assets", () => {
  test("ships the pinned grammar with license and provenance", () => {
    const grammar = join(import.meta.dir, "..", "assets", "tree-sitter-bash.wasm");
    const license = join(import.meta.dir, "..", "assets", "tree-sitter-bash.LICENSE");
    const provenance = join(import.meta.dir, "..", "assets", "tree-sitter-bash.PROVENANCE.md");
    expect(existsSync(grammar)).toBe(true);
    expect(existsSync(license)).toBe(true);
    expect(existsSync(provenance)).toBe(true);
    expect(statSync(grammar).size).toBe(1_358_224);
    expect(createHash("sha256").update(readFileSync(grammar)).digest("hex")).toBe(expectedGrammarHash);
    expect(readFileSync(provenance, "utf8")).toContain(expectedGrammarHash);
  });

  test("resolves the core and grammar WASM explicitly", () => {
    const paths = shellParserAssetPaths();
    expect(existsSync(paths.core)).toBe(true);
    expect(existsSync(paths.grammar)).toBe(true);
  });

  test("publishes assets without the full grammar package", () => {
    const packageJson = packageContract();
    expect(packageJson.files).toContain("assets");
    expect(packageJson.description).toBe(
      "OpenCode command approval plugin with deterministic rules, Tirith scanning, and a restricted direct OpenCode approval agent.",
    );
    expect(packageJson.dependencies).toEqual({
      "@opencode-ai/plugin": "1.17.14",
      "web-tree-sitter": "0.26.11",
      zod: "4.1.13",
    });
  });

  test("publishes only the declared runtime roots and entry contract", () => {
    // Given the machine-consumed package entry, allowlist, and actual Bun pack manifest.
    const packageJson = packageContract();

    // When the package manager computes the publish manifest without writing a release artifact.
    const packed = Bun.spawnSync([process.execPath, "pm", "pack", "--dry-run"], { cwd: packageRoot });
    const output = packed.stdout.toString();
    const packedPaths = output.split("\n").flatMap((line) => {
      const match = /^packed\s+\S+\s+(.+)$/.exec(line);
      return match?.[1] === undefined ? [] : [match[1]];
    });

    // Then root dependencies, runtime entry, required assets, and every shipped path match the positive contract.
    expect(packed.exitCode).toBe(0);
    expect(packageJson).toMatchObject({
      version: "0.5.0",
      main: "src/index.ts",
      exports: { ".": "./src/index.ts" },
      files: ["src", "assets", "README.md", "README.zh-CN.md", "LICENSE"],
      scripts: { typecheck: "tsc -p tsconfig.json --noEmit", test: "bun test test" },
    });
    expect(packedPaths).toContain("package.json");
    expect(packedPaths).toContain(packageJson.main);
    expect(packedPaths).toContain("README.md");
    expect(packedPaths).toContain("README.zh-CN.md");
    expect(packedPaths).toContain("assets/tree-sitter-bash.wasm");
    expect(packedPaths).toContain("assets/tree-sitter-bash.LICENSE");
    expect(packedPaths).toContain("assets/tree-sitter-bash.PROVENANCE.md");
    expect(packedPaths.filter((path) =>
      !["package.json", "LICENSE", "README.md", "README.zh-CN.md"].includes(path)
      && !path.startsWith("src/")
      && !path.startsWith("assets/")
    )).toEqual([]);
  });
});
