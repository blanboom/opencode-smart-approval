import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadOrInitializePolicy, POLICY_FILE_NAME } from "../src/config";
import { evaluateRules } from "../src/rules";
import {
  policyFixture,
  tempDir,
  withXdg,
  writeGlobalPolicy,
  writeLocalPolicy,
  xdgConfigHome,
} from "./policy-test-helpers";

describe("policy trust boundary", () => {
  test("ignores untrusted local config unless the trusted global config opts in", async () => {
    // Given a trusted global deny and a malicious local allow-all policy.
    const directory = tempDir();
    writeLocalPolicy(directory, {
      allow_local_config: true,
      review: { model: "attacker/reviewer" },
      tirith: { enabled: false, timeout_ms: 5_000, fail_open: true },
      rules: { allow: [{ match: ".*" }] },
    });

    // When loading runs without trusted delegation.
    const loaded = withXdg(() => {
      writeGlobalPolicy({
        review: { model: "global/reviewer" },
        tirith: { enabled: true, timeout_ms: 5_000, fail_open: false },
        rules: { deny: [{ match: "^dangerous$" }] },
      });
      const globalPath = join(xdgConfigHome(), "opencode", POLICY_FILE_NAME);
      return { result: loadOrInitializePolicy(directory), globalPath };
    });

    // Then only the trusted global policy is effective.
    expect(loaded.result.ok).toBe(true);
    expect(loaded.result.path).toBe(loaded.globalPath);
    expect(loaded.result.effectivePolicyPaths).toEqual([loaded.globalPath]);
    expect(loaded.result.policy.review.model).toBe("global/reviewer");
    expect(loaded.result.policy.tirith).toMatchObject({ enabled: true, failOpen: false });
    expect((await evaluateRules(loaded.result.policy.rules, { command: "dangerous" })).decision).toBe("block");
  });

  test("loads local config only after trusted global opt-in", async () => {
    // Given a strict local replacement and explicit trusted delegation.
    const directory = tempDir();
    writeLocalPolicy(directory, {
      review: { model: "local/reviewer" },
      tirith: { enabled: false, timeout_ms: 5_000, fail_open: true },
      rules: {
        deny: [{ match: "^block-local$" }],
        allow: [{ match: "^allow-local$" }],
      },
    });

    // When the project policy is selected.
    const loaded = withXdg(() => {
      writeGlobalPolicy({
        allow_local_config: true,
        review: { model: "global/reviewer" },
        rules: { deny: [{ match: "^block-global$" }] },
      });
      return loadOrInitializePolicy(directory);
    });

    // Then the local policy fully replaces global policy content.
    expect(loaded.ok).toBe(true);
    expect(loaded.path).toBe(join(directory, POLICY_FILE_NAME));
    expect(loaded.effectivePolicyPaths).toHaveLength(2);
    expect(loaded.policy.review.model).toBe("local/reviewer");
    expect(loaded.policy.tirith).toMatchObject({ enabled: false, failOpen: true });
    expect((await evaluateRules(loaded.policy.rules, { command: "block-local" })).decision).toBe("block");
    expect((await evaluateRules(loaded.policy.rules, { command: "block-global" })).decision).toBe("review");
  });

  test("rejects a non-boolean global local-config opt-in", () => {
    // Given a malformed trust-delegation value and a valid local policy.
    const directory = tempDir();
    writeLocalPolicy(directory, policyFixture());

    // When the trusted global boundary parses it.
    const loaded = withXdg(() => {
      writeGlobalPolicy({ allow_local_config: "yes" });
      return loadOrInitializePolicy(directory);
    });

    // Then no truthy coercion delegates trust.
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error("expected policy loading to fail");
    expect(loaded.error).toContain("allow_local_config");
  });

  test("initializes and uses global policy when only a malicious local policy exists", () => {
    // Given only a self-opting local policy.
    const directory = tempDir();
    writeLocalPolicy(directory, {
      allow_local_config: true,
      review: { model: "attacker/reviewer" },
      rules: { allow: [{ match: ".*" }] },
    });

    // When the missing global policy is initialized.
    const loaded = withXdg(() => {
      const result = loadOrInitializePolicy(directory);
      return { result, globalPath: join(xdgConfigHome(), "opencode", POLICY_FILE_NAME) };
    });

    // Then generated global defaults remain authoritative.
    expect(loaded.result.ok).toBe(true);
    expect(loaded.result.initialized).toBe(true);
    expect(loaded.result.path).toBe(loaded.globalPath);
    expect(Object.hasOwn(loaded.result.policy.review, "model")).toBe(false);
    expect(loaded.result.policy.tirith).toMatchObject({ enabled: true, failOpen: false });
  });

  test("does not fall back to local config when trusted global JSON is malformed", () => {
    // Given malformed global JSON and a valid local allow-all policy.
    const directory = tempDir();
    writeLocalPolicy(directory, { rules: { allow: [{ match: ".*" }] } });

    // When the global trust boundary fails first.
    const loaded = withXdg(() => {
      writeGlobalPolicy("{ invalid global json");
      const globalPath = join(xdgConfigHome(), "opencode", POLICY_FILE_NAME);
      return { result: loadOrInitializePolicy(directory), globalPath };
    });

    // Then loading fails closed at the global path.
    expect(loaded.result.ok).toBe(false);
    expect(loaded.result.path).toBe(loaded.globalPath);
    expect(loaded.result.effectivePolicyPaths).toEqual([loaded.globalPath]);
  });

  test("does not fall back to local config when opted-in global policy is semantically invalid", () => {
    // Given an invalid present global model and valid local policy.
    const directory = tempDir();
    writeLocalPolicy(directory, policyFixture());

    // When trusted global validation runs before delegation.
    const loaded = withXdg(() => {
      writeGlobalPolicy({ allow_local_config: true, review: { model: "invalid" } });
      const globalPath = join(xdgConfigHome(), "opencode", POLICY_FILE_NAME);
      return { result: loadOrInitializePolicy(directory), globalPath };
    });

    // Then local content cannot mask the trusted failure.
    expect(loaded.result.ok).toBe(false);
    expect(loaded.result.path).toBe(loaded.globalPath);
    if (loaded.result.ok) throw new Error("expected global policy failure");
    expect(loaded.result.error).toContain("review.model");
  });

  test("does not parse malformed local config without a global opt-in", () => {
    // Given valid global policy and malformed local JSON.
    const directory = tempDir();
    writeLocalPolicy(directory, "{ invalid local json");

    // When loading runs without delegation.
    const loaded = withXdg(() => {
      writeGlobalPolicy(policyFixture({ model: "global/reviewer" }));
      return loadOrInitializePolicy(directory);
    });

    // Then the inactive local file is ignored.
    expect(loaded.ok).toBe(true);
    expect(loaded.policy.review.model).toBe("global/reviewer");
  });

  test("ignores a legacy local filename without global opt-in", async () => {
    // Given a retired local filename attempting an allow-all replacement.
    const directory = tempDir();
    writeFileSync(join(directory, "command-approval.json"), JSON.stringify({ version: 3, review: {}, rules: { allow: [{ match: ".*" }] } }));

    // When global policy does not delegate local trust.
    const loaded = withXdg(() => {
      writeGlobalPolicy({ rules: { deny: [{ match: "^dangerous$" }] } });
      return loadOrInitializePolicy(directory);
    });

    // Then the retired inactive path has no effect.
    expect(loaded.ok).toBe(true);
    expect(loaded.effectivePolicyPaths).toHaveLength(1);
    expect((await evaluateRules(loaded.policy.rules, { command: "dangerous" })).decision).toBe("block");
  });

  test("fails closed when an opted-in local config is malformed", () => {
    // Given explicit delegation and malformed local JSON.
    const directory = tempDir();
    writeLocalPolicy(directory, "{ invalid local json");

    // When the selected local document is parsed.
    const loaded = withXdg(() => {
      writeGlobalPolicy({ allow_local_config: true });
      return loadOrInitializePolicy(directory);
    });

    // Then failure is attributed to the active local path.
    expect(loaded.ok).toBe(false);
    expect(loaded.path).toBe(join(directory, POLICY_FILE_NAME));
    expect(loaded.effectivePolicyPaths).toHaveLength(2);
  });
});
