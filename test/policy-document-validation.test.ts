import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadOrInitializePolicy, POLICY_FILE_NAME } from "../src/config";
import {
  policyFixture,
  reviewFixture,
  tempDir,
  withXdg,
  writeGlobalPolicy,
  writeLocalPolicy,
  xdgConfigHome,
} from "./policy-test-helpers";

describe("policy document validation", () => {
  test("keeps the trusted global policy when delegation is enabled but no local file exists", () => {
    // Given a valid global policy that permits project-local configuration.
    const directory = tempDir();
    // When no project-local policy exists.
    const loaded = withXdg(() => {
      writeGlobalPolicy({
        allow_local_config: true,
        review: reviewFixture({ base_url: "https://global.example.com/v1" }),
      });
      return {
        result: loadOrInitializePolicy(directory),
        globalPath: join(xdgConfigHome(), "opencode", POLICY_FILE_NAME),
      };
    });
    // Then the validated global policy remains active.
    expect(loaded.result.ok).toBe(true);
    expect(loaded.result.path).toBe(loaded.globalPath);
    expect(loaded.result.policy.review.baseURL).toBe("https://global.example.com/v1");
  });

  test("fails closed when an opted-in local policy is semantically invalid", () => {
    // Given trusted delegation to a local policy with an invalid retry limit.
    const directory = tempDir();
    writeLocalPolicy(directory, policyFixture(reviewFixture({ max_retries: 11 })));
    // When the delegated local document is validated.
    const loaded = withXdg(() => {
      writeGlobalPolicy({ allow_local_config: true });
      return loadOrInitializePolicy(directory);
    });
    // Then validation fails at the local policy path.
    expect(loaded.ok).toBe(false);
    expect(loaded.path).toBe(join(directory, POLICY_FILE_NAME));
    if (loaded.ok) throw new Error("expected local policy validation to fail");
    expect(loaded.error).toContain("review.max_retries");
  });

  test("rejects an array as the global policy document", () => {
    // Given syntactically valid JSON with the wrong top-level shape.
    const directory = tempDir();
    // When the global document is loaded.
    const loaded = withXdg(() => {
      writeGlobalPolicy("[]");
      return loadOrInitializePolicy(directory);
    });
    // Then loading fails closed instead of silently applying defaults.
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error("expected global policy validation to fail");
    expect(loaded.error).toContain("policy must be a JSON object");
  });

  test("rejects an array as an opted-in local policy document", () => {
    // Given trusted delegation to a local JSON array.
    const directory = tempDir();
    writeLocalPolicy(directory, "[]");
    // When the local document is loaded.
    const loaded = withXdg(() => {
      writeGlobalPolicy({ allow_local_config: true });
      return loadOrInitializePolicy(directory);
    });
    // Then loading fails closed at the local path.
    expect(loaded.ok).toBe(false);
    expect(loaded.path).toBe(join(directory, POLICY_FILE_NAME));
    if (loaded.ok) throw new Error("expected local policy validation to fail");
    expect(loaded.error).toContain("policy must be a JSON object");
  });
});
