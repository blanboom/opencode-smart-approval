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
  test("initializes missing global config and returns defaults", () => {
    const directory = tempDir();
    const result = withXdg(() => {
      const globalPath = join(xdgConfigHome(), "opencode", POLICY_FILE_NAME);
      const loaded = loadOrInitializePolicy(directory);
      const configFile = existsSync(globalPath) ? readFileSync(globalPath, "utf8") : "";
      return {
        loaded,
        fileExists: existsSync(globalPath),
        localExists: existsSync(join(directory, POLICY_FILE_NAME)),
        configFile,
      };
    });
    expect(result.loaded.ok).toBe(true);
    expect(result.loaded.initialized).toBe(true);
    expect(result.loaded.policy.review.baseURL).toBe("https://api.example.com/v1");
    expect(result.loaded.policy.review.apiKey).toBe("your-api-key");
    expect(result.loaded.policy.review.model).toBe("your-model-name");
    expect(result.loaded.policy.review.maxRetries).toBe(3);
    expect(result.fileExists).toBe(true);
    expect(result.localExists).toBe(false);
    expect(result.configFile).toContain("// CommandApproval config");
    expect(result.configFile).not.toContain('"id"');
    expect(JSON.parse(stripJsonComments(result.configFile))).toMatchObject({
      review: { max_retries: 3 },
      tirith: { enabled: true },
      rules: { allow: expect.any(Array), block: expect.any(Array) },
    });
  });

  test("loads global config when no local override exists", () => {
    const directory = tempDir();
    const loaded = withXdg(() => {
      writeGlobalPolicy(
        policyFixture(
          reviewFixture({
            base_url: "https://global.example.com/v1",
            api_key: "global-key",
            model: "global-model",
          }),
        ),
      );
      return loadOrInitializePolicy(directory);
    });
    expect(loaded.ok).toBe(true);
    expect(loaded.policy.review.baseURL).toBe("https://global.example.com/v1");
    expect(loaded.policy.review.apiKey).toBe("global-key");
    expect(loaded.policy.review.model).toBe("global-model");
  });

  test("local config takes priority over global config", () => {
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
    const loaded = withXdg(() => {
      writeGlobalPolicy({
        review: reviewFixture({
          base_url: "https://global.example.com/v1",
          api_key: "global-key",
          model: "global-model",
        }),
        rules: { block: ["^block-global$"], review: ["^review-global$"], allow: ["^allow-global$"] },
      });
      return loadOrInitializePolicy(directory);
    });
    expect(loaded.ok).toBe(true);
    expect(loaded.policy.review.baseURL).toBe("https://local.example.com/v1");
    expect(loaded.policy.review.apiKey).toBe("local-key");
    expect(loaded.policy.review.model).toBe("local-model");
    expect(loaded.policy.riskTool.enabled).toBe(false);
    expect(loaded.policy.riskTool.failOpen).toBe(true);
    expect(loaded.policy.rules.filter((rule) => rule.label.startsWith("block[")).map((rule) => rule.match)).toEqual([
      "^block-local$",
    ]);
    expect(loaded.policy.rules.filter((rule) => rule.label.startsWith("allow[")).map((rule) => rule.match)).toEqual([
      "^allow-local$",
    ]);
  });

  test("loads explicit reviewer endpoint, key, and model from local override", () => {
    const directory = tempDir();
    writeLocalPolicy(directory, policyFixture());
    const loaded = withXdg(() => loadOrInitializePolicy(directory));
    expect(loaded.ok).toBe(true);
    expect(loaded.policy.review.baseURL).toBe("https://example.com/v1");
    expect(loaded.policy.review.apiKey).toBe("test-key");
    expect(loaded.policy.review.model).toBe("test-model");
  });

  test("loads optional risk tool config from global", () => {
    const directory = tempDir();
    const loaded = withXdg(() => {
      writeGlobalPolicy({
        tirith: { enabled: true, path: "/opt/internal/bin/tirith", timeout_ms: 3_000, fail_open: true },
        rules: { block: ["^false$"], allow: ["^echo ok$"] },
      });
      return loadOrInitializePolicy(directory);
    });
    expect(loaded.ok).toBe(true);
    expect(loaded.policy.riskTool).toEqual({
      enabled: true,
      path: "/opt/internal/bin/tirith",
      timeoutMs: 3_000,
      failOpen: true,
    });
  });

  test("loads command approval JSON with comments from local override", () => {
    const directory = tempDir();
    writeLocalPolicy(
      directory,
      `// local override
{
  "review": {
    "base_url": "https://example.com/v1",
    "api_key": "test-key",
    "model": "test-model",
    "timeout_ms": 45000,
    "max_script_bytes": 20000
  },
  "rules": {
    "block": [{ "match": "^false$", "reason": "test denial" }],
    "allow": []
  }
}
`,
    );
    const loaded = withXdg(() => loadOrInitializePolicy(directory));
    expect(loaded.ok).toBe(true);
    expect(loaded.policy.rules[0]?.label).toBe("block[0]");
    expect(loaded.policy.rules[0]?.reason).toBe("test denial");
  });

  test("loads compact string rules and object rules without reason from local", () => {
    const directory = tempDir();
    writeLocalPolicy(
      directory,
      `{
  "rules": {
    "block": ["^false$"],
    "allow": [{ "match": "^echo\\\\s+ok$" }]
  }
}
`,
    );
    const loaded = withXdg(() => loadOrInitializePolicy(directory));
    expect(loaded.ok).toBe(true);
    expect(loaded.policy.rules.map((rule) => ({ decision: rule.decision, label: rule.label, reason: rule.reason })).slice(0, 2)).toEqual([
      { decision: "block", label: "block[0]", reason: undefined },
      { decision: "allow", label: "allow[0]", reason: undefined },
    ]);
  });
});
