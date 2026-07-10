import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadOrInitializePolicy } from "../src/config";
import {
  policyFixture,
  reviewFixture,
  tempDir,
  withXdg,
  writeGlobalPolicy,
  xdgConfigHome,
} from "./policy-test-helpers";

describe("legacy policy compatibility", () => {
  test("loads the legacy global JSON filename", () => {
    // Given a pre-JSONC global policy using the legacy filename.
    const directory = tempDir();
    // When the policy is loaded without a current JSONC file.
    const loaded = withXdg(() => {
      const legacyPath = join(xdgConfigHome(), "opencode", "command-approval.json");
      writeFileSync(
        legacyPath,
        JSON.stringify(policyFixture(reviewFixture({ base_url: "https://legacy-global.example.com/v1" }))),
      );
      return { result: loadOrInitializePolicy(directory), legacyPath };
    });
    // Then the legacy global policy remains supported.
    expect(loaded.result.ok).toBe(true);
    expect(loaded.result.path).toBe(loaded.legacyPath);
    expect(loaded.result.policy.review.baseURL).toBe("https://legacy-global.example.com/v1");
  });

  test("loads the legacy local JSON filename after trusted delegation", () => {
    // Given global delegation and a project policy using the legacy filename.
    const directory = tempDir();
    const legacyPath = join(directory, "command-approval.json");
    writeFileSync(
      legacyPath,
      JSON.stringify(policyFixture(reviewFixture({ base_url: "https://legacy-local.example.com/v1" }))),
    );
    // When the trusted global policy enables local replacement.
    const loaded = withXdg(() => {
      writeGlobalPolicy({ allow_local_config: true });
      return loadOrInitializePolicy(directory);
    });
    // Then the legacy local policy retains the original replacement behavior.
    expect(loaded.ok).toBe(true);
    expect(loaded.path).toBe(legacyPath);
    expect(loaded.policy.review.baseURL).toBe("https://legacy-local.example.com/v1");
  });

  test("accepts risk_tool as the legacy Tirith configuration key", () => {
    // Given a global policy using the original risk_tool key.
    const directory = tempDir();
    // When the policy is parsed.
    const loaded = withXdg(() => {
      writeGlobalPolicy({
        risk_tool: { enabled: false, path: "/opt/legacy/tirith", timeout_ms: 3_000, fail_open: true },
      });
      return loadOrInitializePolicy(directory);
    });
    // Then the legacy fields map to the current Tirith runtime configuration.
    expect(loaded.ok).toBe(true);
    expect(loaded.policy.riskTool).toEqual({
      enabled: false,
      path: "/opt/legacy/tirith",
      timeoutMs: 3_000,
      failOpen: true,
    });
  });
});
