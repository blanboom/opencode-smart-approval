import { describe, expect, test } from "bun:test";
import { loadOrInitializePolicy } from "../src/config";
import { tempDir, withXdg, writeGlobalPolicy } from "./policy-test-helpers";

describe("policy review model loading", () => {
  test("keeps an absent model absent for OpenCode fallback", () => {
    // Given a v3 review object without model.
    const directory = tempDir();

    // When it is loaded.
    const loaded = withXdg(() => {
      writeGlobalPolicy({ review: {} });
      return loadOrInitializePolicy(directory);
    });

    // Then runtime policy does not invent a model value.
    expect(loaded.ok).toBe(true);
    expect(Object.hasOwn(loaded.policy.review, "model")).toBe(false);
  });

  test("retains a valid slash-bearing model remainder", () => {
    // Given a valid provider and nested model identity.
    const directory = tempDir();

    // When it is loaded.
    const loaded = withXdg(() => {
      writeGlobalPolicy({ review: { model: "provider/family/reviewer" } });
      return loadOrInitializePolicy(directory);
    });

    // Then the exact model takes precedence later in registration.
    expect(loaded.ok).toBe(true);
    expect(loaded.policy.review.model).toBe("provider/family/reviewer");
  });

  test.each(["", "provider", "/model", "provider/", " provider/model", "provider/mo del"])(
    "rejects invalid present model %p without fallback",
    (model) => {
      // Given one invalid present model value.
      const directory = tempDir();

      // When the trusted document is loaded.
      const loaded = withXdg(() => {
        writeGlobalPolicy({ review: { model } });
        return loadOrInitializePolicy(directory);
      });

      // Then loading fails closed at model rather than treating it as absent.
      expect(loaded.ok).toBe(false);
      if (loaded.ok) throw new Error("invalid model should fail policy loading");
      expect(loaded.error).toContain("review.model");
    },
  );
});
