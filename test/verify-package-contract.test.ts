import { describe, expect, test } from "bun:test";
import {
  parsePackReceipts,
  requireExtractedPackageContract,
  requireLifecycleSafePackage,
} from "../scripts/package-contract";

describe("package readiness contract", () => {
  test("accepts a package without install or publish lifecycle hooks", () => {
    // Given the package scripts needed by the verified development workflow.
    const packageJson = { scripts: { test: "bun test test", "test:e2e": "bun scripts/verify-opencode-e2e.ts" } };

    // When lifecycle safety is checked before packing.
    const call = () => requireLifecycleSafePackage(packageJson);

    // Then ordinary development scripts remain allowed.
    expect(call).not.toThrow();
  });

  test("rejects every install and publish lifecycle hook", () => {
    // Given all lifecycle hooks forbidden by the plan.
    const hooks = ["prepack", "prepare", "pack", "postpack", "prepublish", "prepublishOnly", "publish", "postpublish", "preinstall", "install", "postinstall"];

    // When each hook crosses the package preflight boundary.
    const calls = hooks.map((hook) => () => requireLifecycleSafePackage({ scripts: { [hook]: "exit 0" } }));

    // Then every hook fails before either pack command can start.
    for (const call of calls) expect(call).toThrow("package_contract");
  });

  test("parses exactly one npm pack JSON receipt with a bounded file list", () => {
    // Given one npm pack receipt for the expected tarball.
    const input = [{ filename: "opencode-smart-approval-0.5.0.tgz", files: [{ path: "package.json" }, { path: "src/index.ts" }] }];

    // When the npm JSON boundary parses it.
    const receipts = parsePackReceipts(input);

    // Then the exact filename and paths are retained.
    expect(receipts).toEqual([{ filename: "opencode-smart-approval-0.5.0.tgz", files: ["package.json", "src/index.ts"] }]);
  });

  test("rejects multiple tarballs and undeclared receipt fields", () => {
    // Given ambiguous and expanded npm pack receipts.
    const multiple = () => parsePackReceipts([
      { filename: "a.tgz", files: [] },
      { filename: "b.tgz", files: [] },
    ]);
    const unknown = () => parsePackReceipts([{ filename: "a.tgz", files: [], ownerPath: "/Users/owner" }]);

    // When the npm JSON boundary parses each input.
    // Then neither receipt can be trusted.
    expect(multiple).toThrow("package_contract");
    expect(unknown).toThrow("package_contract");
  });

  test("accepts only an extracted public package matching its npm receipt", () => {
    // Given matching source/extracted manifests and an exact extracted-file ledger.
    const manifest = {
      name: "opencode-smart-approval",
      version: "0.5.0",
      description: "OpenCode command approval plugin with deterministic rules, Tirith scanning, and a restricted direct OpenCode approval agent.",
      type: "module",
      main: "src/index.ts",
      exports: { ".": "./src/index.ts" },
      files: ["src", "assets", "README.md", "README.zh-CN.md", "LICENSE"],
      scripts: { test: "bun test test" },
      dependencies: { "@opencode-ai/plugin": "1.17.14", "web-tree-sitter": "0.26.11", zod: "4.1.13" },
    };
    const files = ["LICENSE", "README.md", "package.json", "src/index.ts"];

    // When the extracted package boundary compares the manifests and file ledgers.
    const receipt = requireExtractedPackageContract(manifest, manifest, files, files);

    // Then only the unchanged version and exact public file count are emitted.
    expect(receipt).toEqual({ version: "0.5.0", fileCount: 4 });
  });

  test("rejects harness files, receipt drift, lifecycle hooks, and runtime SDK dependencies", () => {
    // Given a minimally valid manifest and four independent package-boundary violations.
    const manifest = {
      name: "opencode-smart-approval",
      version: "0.5.0",
      description: "OpenCode command approval plugin with deterministic rules, Tirith scanning, and a restricted direct OpenCode approval agent.",
      type: "module",
      main: "src/index.ts",
      exports: { ".": "./src/index.ts" },
      files: ["src", "assets", "README.md", "README.zh-CN.md", "LICENSE"],
      dependencies: { "@opencode-ai/plugin": "1.17.14", "web-tree-sitter": "0.26.11", zod: "4.1.13" },
    };
    const calls = [
      () => requireExtractedPackageContract(manifest, manifest, ["package.json"], ["package.json", "scripts/verify.ts"]),
      () => requireExtractedPackageContract(manifest, manifest, ["package.json"], ["src/index.ts"]),
      () => requireExtractedPackageContract(manifest, { ...manifest, scripts: { prepack: "false" } }, ["package.json"], ["package.json"]),
      () => requireExtractedPackageContract(manifest, { ...manifest, dependencies: { ...manifest.dependencies, "@opencode-ai/sdk": "1.17.14" } }, ["package.json"], ["package.json"]),
    ];

    // When each violation crosses the extracted-package boundary.
    // Then all fail closed before package readiness can be claimed.
    for (const call of calls) expect(call).toThrow("package_contract");
  });
});
