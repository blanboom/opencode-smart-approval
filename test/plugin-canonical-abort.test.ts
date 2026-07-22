import { describe, expect, test } from "bun:test";
import { createApprovalPluginIntegration } from "../src/approval-plugin-integration";
import { createMonotonicDeadline } from "../src/bounded-race";
import { reviewWithOpenCode } from "../src/opencode-reviewer";
import type { OpenCodeCallResult } from "../src/opencode-client-adapter";
import type { SerializeReviewRequestInput } from "../src/review-request";
import { FakeAnchoredFsAdapter } from "./fixtures/fake-anchored-fs";
import { fakeClient } from "./fixtures/opencode-client-fake";
import { expectedAgentFixture, validCreatedSession } from "./fixtures/opencode-review-fixtures";

const nestedStringField = (value: unknown, container: string, key: string): string | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const nested = Reflect.get(value, container);
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) return undefined;
  const field = Reflect.get(nested, key);
  return typeof field === "string" ? field : undefined;
};

const request: SerializeReviewRequestInput = {
  context: { sessionID: "parent-session", tool: "bash", command: "scanner-allow", cwd: "/workspace", args: {} },
  shellAnalysis: {
    source: "scanner-allow", segments: [], redirections: [], staticFileReferences: [], issues: [], nestedAnalyses: [],
  },
  evaluation: { decision: "review", matchedRules: [], categories: [], reasons: [] },
  tirith: { action: "allow" },
  transcript: { status: "disabled" },
};

describe("canonical reviewer abort lifecycle", () => {
  test("uses the resolved plugin directory for prompt abort and cleanup", async () => {
    // Given a noncanonical plugin root and a reviewer prompt that only settles after abort.
    const adapter = new FakeAnchoredFsAdapter();
    adapter.addDirectory("/workspace");
    adapter.addDirectory("/tmp");
    const expectedAgent = expectedAgentFixture();
    let completedSetupCalls = 0;
    let settlePrompt: ((value: OpenCodeCallResult) => void) | undefined;
    const prompt = new Promise<OpenCodeCallResult>((resolve) => { settlePrompt = resolve; });
    const client = fakeClient(async (method) => {
      if (method === "agents") {
        completedSetupCalls += 1;
        return { data: [expectedAgent.runtime] };
      }
      if (method === "create") {
        completedSetupCalls += 1;
        return { data: validCreatedSession() };
      }
      if (method === "prompt") return prompt;
      if (method === "abort") {
        settlePrompt?.({ ok: false, code: "transport_error" });
        return { data: true };
      }
      if (method === "delete") return { data: true };
      return { error: { name: "unexpected_call", data: {} } };
    });
    const integration = createApprovalPluginIntegration({
      directory: "/workspace/.",
      project: { id: "project-id" },
      client: client.client,
    }, {
      adapter,
      environment: { XDG_DATA_HOME: "/isolated/data" },
      homeDirectory: "/unused-home",
      tempDirectory: "/tmp",
      createToolExecuteBefore: () => async () => undefined,
    });
    await integration.hooks.config?.({ small_model: "reviewer-provider/reviewer-model" });
    const runtime = integration.reviewerRuntime();
    if (!runtime) throw new Error("reviewer runtime is missing");

    // When the supported deadline leaves one millisecond for the pending prompt.
    const response = await reviewWithOpenCode(runtime, {
      parentSessionID: "parent-session",
      deadline: createMonotonicDeadline(5_000, () => completedSetupCalls >= 3 ? 4_999 : 0),
      request,
    });

    // Then all reviewer calls, including abort and delete, use the one canonical root.
    expect(response.outcome).toBe("deny");
    expect(client.calls.map((call) => call.method)).toEqual([
      "agents", "create", "agents", "prompt", "abort", "delete",
    ]);
    expect(client.calls.map((call) => nestedStringField(call.options, "query", "directory"))).toEqual(
      client.calls.map(() => "/workspace"),
    );
    await integration.hooks.dispose?.();
  });
});
