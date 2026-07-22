import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadOrInitializePolicy, POLICY_FILE_NAME } from "../src/config";
import { tempDir, withXdg, writeGlobalPolicy, xdgConfigHome } from "./policy-test-helpers";

const POLICY_BOUNDARY_KEYS = [
  ["top.version", "version"],
  ["top.allow_local_config", "allow_local_config"],
  ["top.review", "review"],
  ["top.self_protection", "self_protection"],
  ["top.tirith", "tirith"],
  ["top.rules", "rules"],
  ["review.model", "model"],
  ["review.timeout_ms", "timeout_ms"],
  ["review.context_messages", "context_messages"],
  ["review.prompt", "prompt"],
  ["review.cleanup_session", "cleanup_session"],
  ["rules.deny", "deny"],
  ["rules.review", "review"],
  ["rules.allow", "allow"],
  ["rule.match", "match"],
  ["rule.reason", "reason"],
  ["rule.scope", "scope"],
  ["rule.priority", "priority"],
  ["tirith.enabled", "enabled"],
  ["tirith.path", "path"],
  ["tirith.timeout_ms", "timeout_ms"],
  ["tirith.fail_open", "fail_open"],
  ["self_protection.enabled", "enabled"],
] as const;

type AccessCounts = { reads: number; writes: number };

type DescriptorCase = {
  readonly label: string;
  readonly create: (counts: AccessCounts) => PropertyDescriptor;
};

const DESCRIPTORS: readonly DescriptorCase[] = [
  {
    label: "writable inherited data",
    create: () => ({ configurable: true, value: "polluted", writable: true }),
  },
  {
    label: "non-writable inherited data",
    create: () => ({ configurable: true, value: "polluted", writable: false }),
  },
  {
    label: "inherited getter trap",
    create: (counts) => ({
      configurable: true,
      get: () => {
        counts.reads += 1;
        return "polluted";
      },
    }),
  },
  {
    label: "inherited setter trap",
    create: (counts) => ({
      configurable: true,
      set: () => {
        counts.writes += 1;
      },
    }),
  },
];

const COMPLETE_POLICY_SOURCE = JSON.stringify({
  version: 3,
  allow_local_config: false,
  review: {
    model: "fixture/reviewer",
    timeout_ms: 45_000,
    context_messages: 20,
    prompt: "policy-id:prototype-fixture",
    cleanup_session: true,
  },
  self_protection: { enabled: true },
  tirith: { enabled: false, path: "/fixture/tirith", timeout_ms: 5_000, fail_open: false },
  rules: {
    deny: [{ match: "^deny$", reason: "own deny", scope: "command", priority: 3 }],
    review: [{ match: "^review$", reason: "own review", scope: "segment", priority: 2 }],
    allow: [{ match: "^allow$", reason: "own allow", scope: "command", priority: 1 }],
  },
});

const uniqueKeys = new Set(POLICY_BOUNDARY_KEYS.map(([, key]) => key));

afterEach(() => {
  for (const key of uniqueKeys) Reflect.deleteProperty(Object.prototype, key);
  expect([...uniqueKeys].filter((key) => Object.getOwnPropertyDescriptor(Object.prototype, key) !== undefined))
    .toEqual([]);
});

describe("policy prototype descriptor boundary", () => {
  test.each(POLICY_BOUNDARY_KEYS.flatMap(([boundary, key]) => (
    DESCRIPTORS.map((descriptor) => [boundary, key, descriptor] as const)
  )))("fails closed for %s under %s", (_boundary, key, descriptorCase) => {
    // Given a complete own-property policy and one hostile inherited descriptor.
    const directory = tempDir();
    const counts: AccessCounts = { reads: 0, writes: 0 };
    const observed = withXdg(() => {
      writeGlobalPolicy(COMPLETE_POLICY_SOURCE);
      const path = join(xdgConfigHome(), "opencode", POLICY_FILE_NAME);
      Object.defineProperty(Object.prototype, key, descriptorCase.create(counts));
      const loaded = (() => {
        try {
          // When the real loader parses and materializes the policy.
          return loadOrInitializePolicy(directory);
        } finally {
          Reflect.deleteProperty(Object.prototype, key);
        }
      })();
      return { contents: readFileSync(path, "utf8"), loaded, path };
    });

    // Then the boundary fails deterministically before invoking traps or losing own data.
    expect(observed.loaded.ok).toBe(false);
    if (observed.loaded.ok) throw new Error("expected unsafe prototype rejection");
    expect(observed.loaded.error).toBe("policy: unsafe object prototype");
    expect(observed.loaded.path).toBe(observed.path);
    expect(observed.loaded.initialized).toBe(false);
    expect(observed.contents).toBe(COMPLETE_POLICY_SOURCE);
    expect(counts).toEqual({ reads: 0, writes: 0 });
  });
});
