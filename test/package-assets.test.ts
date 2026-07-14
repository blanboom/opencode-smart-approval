import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { shellParserAssetPaths } from "../src/shell-parser";

const expectedGrammarHash = "8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a";

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
    const packageJson = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
      readonly files?: readonly string[];
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    expect(packageJson.files).toContain("assets");
    expect(packageJson.dependencies?.["web-tree-sitter"]).toBe("0.26.11");
    expect(packageJson.dependencies?.["tree-sitter-bash"]).toBeUndefined();
  });
});
