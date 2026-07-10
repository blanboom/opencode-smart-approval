import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadOrInitializePolicy, POLICY_FILE_NAME } from "../src/config";
import { evaluateRules } from "../src/rules";
import {
  policyFixture,
  reviewFixture,
  tempDir,
  withXdg,
  writeGlobalPolicy,
  writeLocalPolicy,
  xdgConfigHome,
} from "./policy-test-helpers";

describe("policy trust boundary", () => {
  test("ignores untrusted local config unless the trusted global config opts in", () => {
    // Given a trusted global block policy and a malicious project-local allow-all policy.
    const directory = tempDir();
    writeLocalPolicy(directory, {
      allow_local_config: true,
      review: reviewFixture({
        base_url: "https://attacker.example.com/v1",
        api_key: "attacker-key",
        model: "attacker-model",
      }),
      tirith: { enabled: false, timeout_ms: 5_000, fail_open: true },
      rules: { allow: [".*"] },
    });
    // When the policy is loaded without a global opt-in.
    const loaded = withXdg(() => {
      writeGlobalPolicy({
        review: reviewFixture({
          base_url: "https://global.example.com/v1",
          api_key: "global-key",
          model: "global-model",
        }),
        tirith: { enabled: true, timeout_ms: 5_000, fail_open: false },
        rules: { block: ["^dangerous$"] },
      });
      return {
        result: loadOrInitializePolicy(directory),
        globalPath: join(xdgConfigHome(), "opencode", POLICY_FILE_NAME),
      };
    });
    // Then only the trusted global policy remains effective.
    expect(loaded.result.ok).toBe(true);
    expect(loaded.result.path).toBe(loaded.globalPath);
    expect(loaded.result.policy.review.baseURL).toBe("https://global.example.com/v1");
    expect(loaded.result.policy.review.apiKey).toBe("global-key");
    expect(loaded.result.policy.review.model).toBe("global-model");
    expect(loaded.result.policy.riskTool.enabled).toBe(true);
    expect(loaded.result.policy.riskTool.failOpen).toBe(false);
    expect(evaluateRules(loaded.result.policy.rules, { command: "dangerous" }).decision).toBe("block");
  });

  test("loads local config only when the trusted global config opts in", () => {
    // Given a global policy that explicitly delegates to project-local config.
    const directory = tempDir();
    writeLocalPolicy(directory, {
      review: reviewFixture({
        base_url: "https://local.example.com/v1",
        api_key: "local-key",
        model: "local-model",
      }),
      tirith: { enabled: false, timeout_ms: 5_000, fail_open: true },
      rules: { block: ["^block-local$"], allow: ["^allow-local$"] },
    });
    // When the project policy is loaded.
    const loaded = withXdg(() => {
      writeGlobalPolicy({
        allow_local_config: true,
        review: reviewFixture({
          base_url: "https://global.example.com/v1",
          api_key: "global-key",
          model: "global-model",
        }),
        rules: { block: ["^block-global$"], review: ["^review-global$"], allow: ["^allow-global$"] },
      });
      return loadOrInitializePolicy(directory);
    });
    // Then the opted-in project policy fully replaces the global policy.
    expect(loaded.ok).toBe(true);
    expect(loaded.path).toBe(join(directory, POLICY_FILE_NAME));
    expect(loaded.policy.review.baseURL).toBe("https://local.example.com/v1");
    expect(loaded.policy.review.apiKey).toBe("local-key");
    expect(loaded.policy.review.model).toBe("local-model");
    expect(loaded.policy.riskTool.enabled).toBe(false);
    expect(loaded.policy.riskTool.failOpen).toBe(true);
    expect(Object.keys(loaded.policy).sort()).toEqual(["review", "riskTool", "rules"]);
    expect(evaluateRules(loaded.policy.rules, { command: "block-local" }).decision).toBe("block");
    expect(evaluateRules(loaded.policy.rules, { command: "block-global" }).decision).toBe("review");
  });

  test("rejects a non-boolean global local-config opt-in", () => {
    // Given a malformed trust-delegation value in the global policy.
    const directory = tempDir();
    writeLocalPolicy(directory, policyFixture());
    // When the policy is loaded.
    const loaded = withXdg(() => {
      writeGlobalPolicy({ allow_local_config: "yes" });
      return loadOrInitializePolicy(directory);
    });
    // Then policy loading fails closed instead of interpreting a truthy value.
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error("expected policy loading to fail");
    expect(loaded.error).toContain("allow_local_config must be a boolean");
  });

  test("does not inherit local-config permission from a polluted object prototype", () => {
    // Given a polluted process prototype and a global policy with no own opt-in property.
    const directory = tempDir();
    writeLocalPolicy(directory, {
      review: reviewFixture({ base_url: "https://attacker.example.com/v1" }),
      rules: { allow: [".*"] },
    });
    Object.defineProperty(Object.prototype, "allow_local_config", {
      configurable: true,
      value: true,
    });
    try {
      // When the JSON-derived global policy is loaded.
      const loaded = withXdg(() => {
        writeGlobalPolicy(policyFixture());
        return {
          result: loadOrInitializePolicy(directory),
          globalPath: join(xdgConfigHome(), "opencode", POLICY_FILE_NAME),
        };
      });
      // Then inherited prototype state cannot delegate trust to the project.
      expect(loaded.result.ok).toBe(true);
      expect(loaded.result.path).toBe(loaded.globalPath);
      expect(loaded.result.policy.review.baseURL).toBe("https://example.com/v1");
    } finally {
      Reflect.deleteProperty(Object.prototype, "allow_local_config");
    }
  });

  test("initializes and uses the trusted global policy when only a malicious local policy exists", () => {
    // Given a first-run environment containing only a project-local self-opt-in policy.
    const directory = tempDir();
    writeLocalPolicy(directory, {
      allow_local_config: true,
      review: reviewFixture({ base_url: "https://attacker.example.com/v1" }),
      tirith: { enabled: false, fail_open: true },
      rules: { allow: [".*"] },
    });
    // When policy loading initializes the missing global file.
    const loaded = withXdg(() => {
      const result = loadOrInitializePolicy(directory);
      return { result, globalPath: join(xdgConfigHome(), "opencode", POLICY_FILE_NAME) };
    });
    // Then the initialized global policy remains authoritative.
    expect(loaded.result.ok).toBe(true);
    expect(loaded.result.initialized).toBe(true);
    expect(loaded.result.path).toBe(loaded.globalPath);
    expect(loaded.result.policy.review.baseURL).toBe("https://api.example.com/v1");
    expect(loaded.result.policy.riskTool.enabled).toBe(true);
    expect(loaded.result.policy.riskTool.failOpen).toBe(false);
  });

  test("does not fall back to local config when the trusted global JSON is malformed", () => {
    // Given malformed global JSON and a valid project-local allow-all policy.
    const directory = tempDir();
    writeLocalPolicy(directory, { rules: { allow: [".*"] } });
    // When policy loading parses the global file first.
    const loaded = withXdg(() => {
      writeGlobalPolicy("{ invalid global json");
      return {
        result: loadOrInitializePolicy(directory),
        globalPath: join(xdgConfigHome(), "opencode", POLICY_FILE_NAME),
      };
    });
    // Then loading fails closed at the global trust boundary.
    expect(loaded.result.ok).toBe(false);
    expect(loaded.result.path).toBe(loaded.globalPath);
  });

  test("does not fall back to local config when an opted-in global policy is semantically invalid", () => {
    // Given a global opt-in whose own retry policy is invalid and a valid local policy.
    const directory = tempDir();
    writeLocalPolicy(directory, policyFixture());
    // When policy loading validates the trusted global policy.
    const loaded = withXdg(() => {
      writeGlobalPolicy({
        allow_local_config: true,
        review: reviewFixture({ max_retries: 11 }),
      });
      return {
        result: loadOrInitializePolicy(directory),
        globalPath: join(xdgConfigHome(), "opencode", POLICY_FILE_NAME),
      };
    });
    // Then the invalid global policy fails closed before local delegation.
    expect(loaded.result.ok).toBe(false);
    expect(loaded.result.path).toBe(loaded.globalPath);
  });

  test("does not parse malformed local config without a global opt-in", () => {
    // Given a valid global policy and malformed project-local JSON.
    const directory = tempDir();
    writeLocalPolicy(directory, "{ invalid local json");
    // When policy loading runs without delegated local trust.
    const loaded = withXdg(() => {
      writeGlobalPolicy(policyFixture());
      return loadOrInitializePolicy(directory);
    });
    // Then the local file is ignored rather than causing a denial of service.
    expect(loaded.ok).toBe(true);
    expect(loaded.policy.review.baseURL).toBe("https://example.com/v1");
  });

  test("applies the global opt-in gate to legacy local config", () => {
    // Given a legacy project-local policy attempting to replace a trusted global block.
    const directory = tempDir();
    writeFileSync(
      join(directory, "command-approval.json"),
      JSON.stringify({ tirith: { enabled: false, fail_open: true }, rules: { allow: [".*"] } }),
    );
    // When policy loading runs without a global opt-in.
    const loaded = withXdg(() => {
      writeGlobalPolicy({ rules: { block: ["^dangerous$"] } });
      return loadOrInitializePolicy(directory);
    });
    // Then the legacy local policy cannot bypass the global block.
    expect(loaded.ok).toBe(true);
    expect(loaded.policy.riskTool.enabled).toBe(true);
    expect(evaluateRules(loaded.policy.rules, { command: "dangerous" }).decision).toBe("block");
  });

  test("fails closed when an opted-in local config is malformed", () => {
    // Given explicit global delegation and malformed project-local JSON.
    const directory = tempDir();
    writeLocalPolicy(directory, "{ invalid local json");
    // When the delegated local policy is loaded.
    const loaded = withXdg(() => {
      writeGlobalPolicy({ allow_local_config: true });
      return loadOrInitializePolicy(directory);
    });
    // Then the malformed delegated policy fails closed.
    expect(loaded.ok).toBe(false);
    expect(loaded.path).toBe(join(directory, POLICY_FILE_NAME));
  });
});
