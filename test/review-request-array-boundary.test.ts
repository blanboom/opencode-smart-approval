import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { serializeReviewRequest } from "../src/review-request";
import type { SerializeReviewRequestInput } from "../src/review-request";

const serializeArgs = (args: unknown) => serializeReviewRequest({
  context: { sessionID: "parent", tool: "bash", command: "echo ok", cwd: "/workspace", args },
  shellAnalysis: {
    source: "echo ok",
    segments: [],
    redirections: [],
    staticFileReferences: [],
    issues: [],
    nestedAnalyses: [],
  },
  evaluation: { decision: "review", matchedRules: [], categories: [], reasons: [] },
  tirith: { action: "allow" },
  transcript: { status: "disabled" },
} satisfies SerializeReviewRequestInput);

class ArraySubclass extends Array<unknown> {}

const replacedPrototype = (): unknown => {
  const value = [1, 2];
  Object.setPrototypeOf(value, {});
  return value;
};

const customProperty = (enumerable: boolean): unknown => {
  const value = [1];
  Object.defineProperty(value, "extra", { value: true, enumerable, configurable: true });
  return value;
};

const symbolProperty = (): unknown => {
  const value = [1];
  Object.defineProperty(value, Symbol("extra"), { value: true, enumerable: false, configurable: true });
  return value;
};

const indexAccessor = (): unknown => {
  const value = [1];
  Object.defineProperty(value, "0", { get: () => 1, enumerable: true, configurable: true });
  return value;
};

const tamperedOwnKeys = (): unknown => new Proxy([1], {
  ownKeys: () => ["0", "extra", "length"],
  getOwnPropertyDescriptor: (target, key) => key === "extra"
    ? { value: true, writable: true, enumerable: false, configurable: true }
    : Reflect.getOwnPropertyDescriptor(target, key),
});

const tamperedLengthDescriptor = (): unknown => new Proxy([1], {
  getOwnPropertyDescriptor: (target, key) => key === "length"
    ? { value: 2, writable: true, enumerable: false, configurable: false }
    : Reflect.getOwnPropertyDescriptor(target, key),
});

const throwingPrototypeTrap = (): unknown => new Proxy([1], {
  getPrototypeOf: () => { throw new Error("prototype trap"); },
});

const throwingOwnKeysTrap = (): unknown => new Proxy([1], {
  ownKeys: () => { throw new Error("ownKeys trap"); },
});

const throwingDescriptorTrap = (): unknown => new Proxy([1], {
  getOwnPropertyDescriptor: () => { throw new Error("descriptor trap"); },
});

describe("stable ReviewRequest array boundary", () => {
  test.each([
    ["Array subclass", () => new ArraySubclass(1, 2)],
    ["replaced prototype", replacedPrototype],
    ["cross-realm array", () => runInNewContext("[1, 2]")],
    ["holey array", () => new Array<unknown>(2)],
    ["enumerable custom property", () => customProperty(true)],
    ["non-enumerable custom property", () => customProperty(false)],
    ["symbol property", symbolProperty],
    ["index accessor", indexAccessor],
    ["tampered own keys", tamperedOwnKeys],
    ["tampered length descriptor", tamperedLengthDescriptor],
    ["throwing prototype trap", throwingPrototypeTrap],
    ["throwing ownKeys trap", throwingOwnKeysTrap],
    ["throwing descriptor trap", throwingDescriptorTrap],
  ] as const)("rejects %s", (_label, createArgs) => {
    // Given an Array.isArray-compatible value outside the exact plain dense-array contract.
    // When it crosses the public ReviewRequest serialization boundary.
    const result = serializeArgs(createArgs());

    // Then it fails closed with the fixed JSON classification.
    expect(result).toEqual({ ok: false, code: "invalid_json" });
  });

  test.each([
    ["empty", []],
    ["plain", [1, { safe: true }]],
    ["frozen", Object.freeze([1, 2])],
  ] as const)("accepts a legitimate %s plain array", (_label, args) => {
    // Given an exact native dense array, including the frozen length-descriptor form.
    // When it crosses the public ReviewRequest serialization boundary.
    const result = serializeArgs(args);

    // Then ordinary arrays remain serializable.
    expect(result.ok).toBe(true);
  });
});
