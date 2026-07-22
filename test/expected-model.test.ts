import { describe, expect, test } from "bun:test";
import { expectedModelFromConfigured, expectedModelMatches } from "../src/expected-model";

describe("approval reviewer expected model", () => {
  test("normalizes a configured provider and slash-bearing model ID", () => {
    // Given a pre-v3 small_model containing a provider and model identity.
    const configured = "provider/family/reviewer";

    // When the fixed expectation is derived.
    const result = expectedModelFromConfigured(configured);

    // Then the provider boundary is the first slash and the source stays explicit.
    expect(result).toEqual({
      ok: true,
      value: { source: "v3_or_small_model", providerID: "provider", modelID: "family/reviewer" },
    });
  });

  test.each(["", "provider", "/model", "provider/"])("rejects invalid configured model %s", (configured) => {
    // Given an invalid fixed-model spelling.
    // When the expectation is derived.
    const result = expectedModelFromConfigured(configured);

    // Then no inherited fallback masks the invalid configuration.
    expect(result).toEqual({ ok: false, code: "invalid_model" });
  });

  test("keeps absent configuration inherited and validates response identity", () => {
    // Given no configured model and an OpenCode-selected response model.
    const result = expectedModelFromConfigured(undefined);
    if (!result.ok) throw new Error("expected inherited model");

    // When agent and response identities are checked.
    const agentMatches = expectedModelMatches(result.value, undefined, false);
    const responseMatches = expectedModelMatches(
      result.value,
      { providerID: "runtime", modelID: "selected" },
      true,
    );

    // Then the agent must omit model while the response must identify its selection.
    expect(result.value).toEqual({ source: "inherited" });
    expect([agentMatches, responseMatches]).toEqual([true, true]);
  });

  test("requires exact fixed identities", () => {
    // Given one configured fixed model.
    const result = expectedModelFromConfigured("provider/model");
    if (!result.ok) throw new Error("expected fixed model");

    // When matching exact and changed runtime identities.
    const exact = expectedModelMatches(result.value, { providerID: "provider", modelID: "model" }, false);
    const changed = expectedModelMatches(result.value, { providerID: "provider", modelID: "other" }, true);

    // Then both agent and response checks are source-locked to the exact identity.
    expect([exact, changed]).toEqual([true, false]);
  });
});
