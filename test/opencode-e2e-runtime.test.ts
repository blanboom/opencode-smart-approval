import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { buildHarnessConfigDocuments, type ModelRoute } from "../scripts/opencode-e2e/config";
import { seedIsolatedPluginDependency } from "../scripts/opencode-e2e/dependency-seed";
import { isTcpPortOpen, waitForPortClosure } from "../scripts/opencode-e2e/runtime-process";
import { createScenarioDeadline, SCENARIO_TIMEOUT_MS } from "../scripts/opencode-e2e/scenario-deadline";
import { unwrapNoContent, unwrapSdkData, unwrapSessionId, unwrapStatusMap, unwrapTrue } from "../scripts/opencode-e2e/sdk";
import { parsePolicyJsonc, policyDocumentFromUnknown } from "../src/policy-parser";

describe("isolated OpenCode config documents", () => {
  test.each([
    ["explicit", "openai/fixture-explicit", "openai/fixture-reviewer"],
    ["small", undefined, "openai/fixture-reviewer"],
    ["inherited", undefined, undefined],
    ["fault", "openai/fixture-fault", "openai/fixture-reviewer"],
    ["hang", "openai/fixture-hang", "openai/fixture-reviewer"],
  ] satisfies readonly (readonly [ModelRoute, string | undefined, string | undefined])[])(
    "routes the $0 reviewer model without compatibility fallback",
    (modelRoute, policyModel, smallModel) => {
      // Given one model-precedence route and a later plugin URL.
      const input = {
        providerOrigin: "http://127.0.0.1:43210/v1",
        pluginUrl: "file:///workspace/src/index.ts",
        laterPluginUrl: "file:///workspace/fixtures/later.ts",
        modelRoute,
        cleanupSession: false,
      };

      // When stable OpenCode and policy documents are built.
      const documents = buildHarnessConfigDocuments(input);
      const opencode: unknown = JSON.parse(documents.opencode);
      const resolved = policyDocumentFromUnknown(parsePolicyJsonc(documents.policy), []);

      // Then plugin order, exact provider base, model ladder, and retention policy are machine-readable.
      expect(opencode).toMatchObject({
        enabled_providers: ["openai"],
        model: "openai/fixture-primary",
        plugin: [input.pluginUrl, input.laterPluginUrl],
        provider: { openai: { npm: "@ai-sdk/openai", options: { apiKey: "fixture-key", baseURL: input.providerOrigin } } },
      });
      expect(Reflect.get(opencode ?? {}, "small_model")).toBe(smallModel);
      expect(resolved.policy.review.model).toBe(policyModel);
      expect(resolved.policy.review.timeoutMs).toBe(10_000);
      expect(resolved.policy.review.cleanupSession).toBe(false);
      expect(resolved.policy.tirith.enabled).toBe(false);
    },
  );
});

describe("flattened v2 SDK boundary", () => {
  test("unwraps one valid data envelope through its caller schema", () => {
    // Given one successful SDK envelope and a strict caller schema.
    const schema = z.object({ value: z.literal("ok") }).strict();

    // When the boundary unwraps it.
    const data = unwrapSdkData({ data: { value: "ok" }, response: {} }, schema);

    // Then only the parsed caller-owned data is returned.
    expect(data).toEqual({ value: "ok" });
  });

  test("rejects error, missing, contradictory, and malformed SDK envelopes", () => {
    // Given every non-success envelope branch.
    const schema = z.string();
    const calls = [
      () => unwrapSdkData({ error: { message: "secret" } }, schema),
      () => unwrapSdkData({ response: {} }, schema),
      () => unwrapSdkData({ data: "ok", error: { message: "secret" } }, schema),
      () => unwrapSdkData({ data: 42 }, schema),
    ];

    // When each result crosses the SDK boundary.
    // Then all branches fail with redacted typed categories.
    expect(calls[0]).toThrow("sdk_error");
    for (const call of calls.slice(1)) expect(call).toThrow("sdk_malformed");
  });

  test("unwraps exact session ID, status map, and true deletion", () => {
    // Given source-runtime session, status, and delete envelopes.
    const session = { data: { id: "ses_fixture", title: "fixture" } };
    const status = { data: { ses_fixture: { type: "idle" } } };

    // When specialized boundaries unwrap each value.
    const sessionId = unwrapSessionId(session);
    const statusMap = unwrapStatusMap(status);
    const deleted = unwrapTrue({ data: true });

    // Then exact IDs and idle/deletion states survive without extra assumptions.
    expect(sessionId).toBe("ses_fixture");
    expect(statusMap).toEqual({ ses_fixture: { type: "idle" } });
    expect(deleted).toBe(true);
    expect(() => unwrapTrue({ data: false })).toThrow("sdk_malformed");
  });

  test("spends one absolute deadline across sequential operations", async () => {
    // Given a deterministic clock and a signal factory that records every operation budget.
    const startedAt = 4_000;
    let currentTime = startedAt;
    const signalBudgets: number[] = [];
    const deadline = createScenarioDeadline({
      now: () => currentTime,
      signalFactory: (milliseconds) => {
        signalBudgets.push(milliseconds);
        return new AbortController().signal;
      },
    });

    // When three sequential operations consume the complete scenario budget.
    await deadline.run(async () => {
      currentTime += 6_000;
      return true;
    });
    await deadline.run(async () => {
      currentTime += 13_999;
      return true;
    });
    const hangingAtBoundary = deadline.run(async () => {
      currentTime += 1;
      return await new Promise<true>(() => undefined);
    });
    await expect(hangingAtBoundary).rejects.toThrow("deadline");
    let invokedAfterExpiry = false;
    const afterExpiry = deadline.run(async () => {
      invokedAfterExpiry = true;
      return true;
    });

    // Then later signals receive only the remaining time and no operation starts after 20 seconds.
    expect(signalBudgets).toEqual([SCENARIO_TIMEOUT_MS, 14_000, 1]);
    expect(currentTime - startedAt).toBe(SCENARIO_TIMEOUT_MS);
    await expect(afterExpiry).rejects.toThrow("deadline");
    expect(invokedAfterExpiry).toBe(false);
  });

  test("accepts only the flattened 204 no-content SDK envelope", () => {
    // Given one exact prompt-async response and malformed success/error alternatives.
    const accepted = { data: undefined, error: undefined, response: new Response(null, { status: 204 }) };

    // When the no-content boundary validates the SDK result.
    const receipt = unwrapNoContent(accepted);

    // Then only HTTP 204 without SDK error is accepted.
    expect(receipt).toBe(true);
    expect(() => unwrapNoContent({ response: new Response(null, { status: 200 }) })).toThrow("sdk_malformed");
    expect(() => unwrapNoContent({ error: { message: "secret" }, response: new Response(null, { status: 204 }) })).toThrow("sdk_error");
  });
});

describe("isolated OpenCode config dependency", () => {
  test("copies the exact plugin and writes matching npm lock metadata", () => {
    // Given a fresh isolated config directory and the frozen project install.
    const root = mkdtempSync(join(tmpdir(), "opencode-plugin-seed-test-"));
    const packageRoot = resolve(import.meta.dir, "..");
    const configDirectory = join(root, "config", "opencode");

    try {
      // When the deterministic config dependency is seeded without npm or network.
      const receipt = seedIsolatedPluginDependency(packageRoot, configDirectory);
      const copied: unknown = JSON.parse(readFileSync(join(configDirectory, "node_modules", "@opencode-ai", "plugin", "package.json"), "utf8"));
      const lock: unknown = JSON.parse(readFileSync(join(configDirectory, "package-lock.json"), "utf8"));

      // Then the copied package, dependency declaration, and pinned integrity agree exactly.
      expect(receipt).toEqual({
        name: "@opencode-ai/plugin",
        version: "1.17.14",
        integrity: "sha512-upKf4QHZqjr2cqHJcJiGTUSGJFFVR26Nu8Y2QRThQ2NgXcQ44T1cRvI80nhK87wQsFcHPI842d+cPYERV+lB4w==",
      });
      expect(copied).toMatchObject({ name: receipt.name, version: receipt.version });
      expect(lock).toMatchObject({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { "@opencode-ai/plugin": "1.17.14" } },
          "node_modules/@opencode-ai/plugin": { version: receipt.version, integrity: receipt.integrity },
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("exact loopback port teardown", () => {
  test("observes a listener and then its bounded closure", async () => {
    // Given one harness-owned OS-assigned loopback listener.
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    const port = server.port;
    if (port === undefined) throw new Error("missing fixture port");

    // When the exact listener is closed.
    expect(await isTcpPortOpen(port)).toBe(true);
    await server.stop(true);

    // Then the bounded teardown probe observes the exact port as closed.
    expect(await waitForPortClosure(port, 1_000)).toBe(true);
  });
});
