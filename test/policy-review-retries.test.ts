import { describe, expect, test } from "bun:test";
import { loadOrInitializePolicy } from "../src/config";
import {
  policyFixture,
  reviewFixture,
  tempDir,
  withXdg,
  writeLocalPolicy,
} from "./policy-test-helpers";

const acceptedRetryCases = [
  { name: "snake_case", field: "max_retries", value: 5, expected: 5 },
  { name: "camelCase", field: "maxRetries", value: 2, expected: 2 },
] as const;

const rejectedRetryCases = [
  {
    name: "outside supported range",
    field: "max_retries",
    value: 11,
    expected: "review.max_retries",
  },
  {
    name: "fractional value",
    field: "max_retries",
    value: 1.5,
    expected: "review.max_retries must be an integer between 0 and 10",
  },
  {
    name: "string value",
    field: "max_retries",
    value: "0",
    expected: "review.max_retries must be an integer between 0 and 10",
  },
  {
    name: "null camelCase value",
    field: "maxRetries",
    value: null,
    expected: "review.max_retries must be an integer between 0 and 10",
  },
] as const;

describe("policy review retries", () => {
  for (const retryCase of acceptedRetryCases) {
    test(`loads explicit reviewer retry count from ${retryCase.name} config`, () => {
      const directory = tempDir();
      writeLocalPolicy(
        directory,
        policyFixture(reviewFixture({ [retryCase.field]: retryCase.value })),
      );
      const loaded = withXdg(() => loadOrInitializePolicy(directory));
      expect(loaded.ok).toBe(true);
      expect(loaded.policy.review.maxRetries).toBe(retryCase.expected);
    });
  }

  for (const retryCase of rejectedRetryCases) {
    test(`rejects reviewer retry count with ${retryCase.name}`, () => {
      const directory = tempDir();
      writeLocalPolicy(
        directory,
        policyFixture(reviewFixture({ [retryCase.field]: retryCase.value })),
      );
      const loaded = withXdg(() => loadOrInitializePolicy(directory));
      expect(loaded.ok).toBe(false);
      if (loaded.ok) throw new Error(`${retryCase.name} should fail policy loading`);
      expect(loaded.error).toContain(retryCase.expected);
    });
  }
});
