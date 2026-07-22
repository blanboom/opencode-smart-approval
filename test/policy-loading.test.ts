import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadOrInitializePolicy, POLICY_FILE_NAME, stripJsonComments } from "../src/config";
import {
  policyFixture,
  reviewFixture,
  tempDir,
  withXdg,
  writeGlobalPolicy,
  writeLocalPolicy,
  xdgConfigHome,
} from "./policy-test-helpers";

describe("policy loading", () => {
  test("initializes only a strict JSONC v3 global config and returns defaults", () => {
    // Given a missing trusted global policy.
    const directory = tempDir();

    // When the loader initializes it.
    const result = withXdg(() => {
      const globalPath = join(xdgConfigHome(), "opencode", POLICY_FILE_NAME);
      const loaded = loadOrInitializePolicy(directory);
      return {
        loaded,
        fileExists: existsSync(globalPath),
        localExists: existsSync(join(directory, POLICY_FILE_NAME)),
        configFile: readFileSync(globalPath, "utf8"),
      };
    });

    // Then the generated document and runtime defaults are v3-only.
    expect(result.loaded.ok).toBe(true);
    expect(result.loaded.initialized).toBe(true);
    expect(result.loaded.policy.review).toEqual({ timeoutMs: 45_000, contextMessages: 20, cleanupSession: true });
    expect(result.fileExists).toBe(true);
    expect(result.localExists).toBe(false);
    expect(result.configFile).toContain("// CommandApproval config");
    expect(JSON.parse(stripJsonComments(result.configFile))).toEqual({
      version: 3,
      allow_local_config: false,
      self_protection: { enabled: true },
      review: {},
      tirith: { enabled: true, timeout_ms: 5_000, fail_open: false },
      rules: { deny: [], review: [], allow: [] },
    });
  });

  test("loads a global v3 model and review options", () => {
    // Given a complete strict global review object.
    const directory = tempDir();

    // When it is loaded.
    const loaded = withXdg(() => {
      writeGlobalPolicy(policyFixture(reviewFixture({
        model: "global-provider/family/reviewer",
        context_messages: 0,
        cleanup_session: false,
        prompt: "global guidance",
      })));
      return loadOrInitializePolicy(directory);
    });

    // Then the exact validated settings reach runtime form.
    expect(loaded.ok).toBe(true);
    expect(loaded.policy.review).toEqual({
      model: "global-provider/family/reviewer",
      timeoutMs: 45_000,
      contextMessages: 0,
      prompt: "global guidance",
      cleanupSession: false,
    });
  });

  test("loads a strict local override only after trusted opt-in", () => {
    // Given a local v3 model and a trusted global delegation.
    const directory = tempDir();
    writeLocalPolicy(directory, policyFixture(reviewFixture({ model: "local-provider/local-model" })));

    // When the delegated file is loaded.
    const loaded = withXdg(() => {
      writeGlobalPolicy({ allow_local_config: true });
      return loadOrInitializePolicy(directory);
    });

    // Then the local policy replaces the global policy.
    expect(loaded.ok).toBe(true);
    expect(loaded.path).toBe(join(directory, POLICY_FILE_NAME));
    expect(loaded.policy.review.model).toBe("local-provider/local-model");
  });

  test("loads preserved Tirith configuration and strict deny/allow rules", () => {
    // Given strict preserved v3 policy fields.
    const directory = tempDir();

    // When they are loaded.
    const loaded = withXdg(() => {
      writeGlobalPolicy({
        tirith: { enabled: true, path: "/opt/internal/bin/tirith", timeout_ms: 3_000, fail_open: true },
        rules: { deny: [{ match: "^false$" }], allow: [{ match: "^echo ok$" }] },
      });
      return loadOrInitializePolicy(directory);
    });

    // Then the runtime configuration and rule labels are canonical.
    expect(loaded.ok).toBe(true);
    expect(loaded.policy.tirith).toEqual({
      enabled: true,
      path: "/opt/internal/bin/tirith",
      timeoutMs: 3_000,
      failOpen: true,
    });
    expect(loaded.policy.rules.slice(0, 2).map((rule) => rule.label)).toEqual(["deny[0]", "allow[0]"]);
  });

  test("loads strict JSONC object rules with optional reason", () => {
    // Given a commented local v3 document.
    const directory = tempDir();
    writeLocalPolicy(directory, `// local override
{
  "version": 3,
  "review": {},
  "rules": {
    "deny": [{ "match": "^false$", "reason": "test denial" }],
    "allow": [{ "match": "^echo\\\\s+ok$" }]
  }
}
`);

    // When trusted delegation loads it.
    const loaded = withXdg(() => {
      writeGlobalPolicy({ allow_local_config: true });
      return loadOrInitializePolicy(directory);
    });

    // Then object-only rules compile with exact reason semantics.
    expect(loaded.ok).toBe(true);
    expect(loaded.policy.rules.slice(0, 2).map((rule) => ({ label: rule.label, reason: rule.reason }))).toEqual([
      { label: "deny[0]", reason: "test denial" },
      { label: "allow[0]", reason: undefined },
    ]);
  });
});
