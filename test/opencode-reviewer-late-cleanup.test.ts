import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { createMonotonicDeadline } from "../src/bounded-race";
import type { OpenCodeCallResult } from "../src/opencode-client-adapter";
import { reviewWithOpenCode } from "../src/opencode-reviewer";
import type { SerializeReviewRequestInput } from "../src/review-request";
import { expectedAgentFixture, validCreatedSession } from "./fixtures/opencode-review-fixtures";
import { reviewRuntimeFixture } from "./fixtures/opencode-review-runtime";

const request: SerializeReviewRequestInput = {
  context: { sessionID: "parent-session", tool: "bash", command: "echo ok", cwd: "/workspace", args: {} },
  shellAnalysis: {
    source: "echo ok", segments: [], redirections: [], staticFileReferences: [], issues: [], nestedAnalyses: [],
  },
  evaluation: { decision: "review", matchedRules: [], categories: [], reasons: [] },
  tirith: { action: "allow" },
  transcript: { status: "disabled" },
};

type LifecycleOperation = () => Promise<OpenCodeCallResult>;

const startLateCleanup = async (deleteOperation: LifecycleOperation, logOperation: LifecycleOperation) => {
  const agent = expectedAgentFixture();
  let completedAgentCalls = 0;
  let settleCreate: ((value: OpenCodeCallResult) => void) | undefined;
  let observeCreate: (() => void) | undefined;
  let observeDelete: (() => void) | undefined;
  let observeLog: (() => void) | undefined;
  const created = new Promise<OpenCodeCallResult>((resolve) => { settleCreate = resolve; });
  const createStarted = new Promise<void>((resolve) => { observeCreate = resolve; });
  const deleteStarted = new Promise<void>((resolve) => { observeDelete = resolve; });
  const logStarted = new Promise<void>((resolve) => { observeLog = resolve; });
  const fixture = reviewRuntimeFixture(async (method) => {
    if (method === "agents") {
      completedAgentCalls += 1;
      return { ok: true, data: [agent.runtime] };
    }
    if (method === "create") { observeCreate?.(); return created; }
    if (method === "delete") { observeDelete?.(); return deleteOperation(); }
    if (method === "log") { observeLog?.(); return logOperation(); }
    return { ok: false, code: "sdk_error" };
  });
  const responsePending = reviewWithOpenCode(fixture.runtime, {
    parentSessionID: "parent-session",
    deadline: createMonotonicDeadline(5_000, () => completedAgentCalls > 0 ? 4_999 : 0),
    request,
  });
  await createStarted;
  jest.advanceTimersByTime(1);
  const response = await responsePending;
  settleCreate?.({ ok: true, data: validCreatedSession() });
  return { deleteStarted, fixture, logStarted, response };
};

const recordField = (value: unknown, key: string): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Reflect.get(value, key);
};

const logInput = (fixture: Awaited<ReturnType<typeof startLateCleanup>>["fixture"]): unknown =>
  fixture.calls.find((call) => call.method === "log")?.input;

const expectedLogInput = (result: "success" | "timeout" | "error") => ({
  directory: "/workspace",
  service: "opencode-smart-approval",
  level: "warn",
  message: "review.late_create_cleanup",
  extra: { event: "late_create", child_id: "child-session", result },
  signal: expect.any(AbortSignal),
});

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const ERROR_CASES: readonly (readonly [string, LifecycleOperation])[] = [
  ["SDK envelope", async () => ({ ok: false, code: "sdk_error" })],
  ["false result", async () => ({ ok: false, code: "false_result" })],
  ["transport result", async () => ({ ok: false, code: "transport_error" })],
  ["missing data", async () => ({ ok: false, code: "missing_data" })],
  ["malformed data", async () => ({ ok: false, code: "invalid_envelope" })],
  ["rejected promise", async () => { throw new Error("private delete rejection"); }],
];

const LOG_FAILURE_CASES: readonly (readonly [string, LifecycleOperation])[] = [
  ["false", async () => ({ ok: false, code: "false_result" })],
  ["rejection", async () => { throw new Error("private log rejection"); }],
];

describe("late-created child cleanup diagnostics", () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test("logs timeout and sinks rejection after the fixed delete bound", async () => {
    // Given an exact late child whose delete remains pending beyond the fixed cleanup bound.
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", observeUnhandled);
    let rejectDelete: ((reason: Error) => void) | undefined;
    const deletePending = new Promise<OpenCodeCallResult>((_resolve, reject) => { rejectDelete = reject; });
    try {
      const scenario = await startLateCleanup(
        () => deletePending,
        async () => ({ ok: true, data: true }),
      );
      const returnedDenial = JSON.stringify(scenario.response);

      // When cleanup times out, logs, and the original delete rejects after that log.
      await scenario.deleteStarted;
      jest.advanceTimersByTime(2_000);
      await scenario.logStarted;
      const callsBeforeSettlement = scenario.fixture.calls.map((call) => call.method);
      const handle = scenario.fixture.runtime.registry.get("child-session");
      const terminal = handle?.snapshot();
      rejectDelete?.(new Error("late private delete rejection"));
      await flushMicrotasks();

      // Then timeout remains distinct and late settlement cannot escape or mutate lifecycle state.
      expect(logInput(scenario.fixture)).toEqual(expectedLogInput("timeout"));
      expect(callsBeforeSettlement).toEqual(["agents", "create", "delete", "log"]);
      expect(scenario.fixture.calls.map((call) => call.method)).toEqual(callsBeforeSettlement);
      expect(scenario.response.outcome).toBe("deny");
      expect(JSON.stringify(scenario.response)).toBe(returnedDenial);
      expect(handle?.snapshot()).toEqual(terminal);
      expect(terminal?.state).toBe("cleanup_failed");
      expect(scenario.fixture.activations).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  test.each(ERROR_CASES)("logs error for a non-timeout %s delete failure", async (_label, operation) => {
    // Given a late child whose exact delete fails without exhausting its time bound.
    const scenario = await startLateCleanup(operation, async () => ({ ok: true, data: true }));

    // When the cleanup result reaches the allowlisted diagnostic call.
    await scenario.logStarted;
    await flushMicrotasks();

    // Then every non-timeout failure maps to error without provider-controlled fields.
    expect(logInput(scenario.fixture)).toEqual(expectedLogInput("error"));
    expect(scenario.fixture.calls.map((call) => call.method)).toEqual(["agents", "create", "delete", "log"]);
    expect(scenario.fixture.runtime.registry.get("child-session")?.snapshot().state).toBe("cleanup_failed");
    expect(scenario.response.outcome).toBe("deny");
  });

  test.each(LOG_FAILURE_CASES)("swallows immediate app.log %s after settlement handling", async (_label, operation) => {
    // Given successful late-child deletion followed by a failing diagnostic call.
    const scenario = await startLateCleanup(async () => ({ ok: true, data: true }), operation);

    // When the diagnostic settles unsuccessfully.
    await scenario.logStarted;
    await flushMicrotasks();

    // Then the returned denial and terminal handle remain unchanged with one log attempt.
    expect(logInput(scenario.fixture)).toEqual(expectedLogInput("success"));
    expect(scenario.fixture.calls.map((call) => call.method)).toEqual(["agents", "create", "delete", "log"]);
    expect(scenario.fixture.runtime.registry.get("child-session")).toBeUndefined();
    expect(scenario.response.outcome).toBe("deny");
  });

  test("sinks a late app.log rejection after its fixed timeout", async () => {
    // Given successful deletion and an app.log promise that remains pending beyond its bound.
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", observeUnhandled);
    let rejectLog: ((reason: Error) => void) | undefined;
    const logPending = new Promise<OpenCodeCallResult>((_resolve, reject) => { rejectLog = reject; });
    try {
      const scenario = await startLateCleanup(async () => ({ ok: true, data: true }), () => logPending);

      // When log exhausts its fixed bound and rejects afterward.
      await scenario.logStarted;
      jest.advanceTimersByTime(1_000);
      rejectLog?.(new Error("late private log rejection"));
      await flushMicrotasks();

      // Then its sink prevents escape, retries, verdict mutation, or handle resurrection.
      expect(logInput(scenario.fixture)).toEqual(expectedLogInput("success"));
      expect(scenario.fixture.calls.map((call) => call.method)).toEqual(["agents", "create", "delete", "log"]);
      expect(scenario.fixture.runtime.registry.get("child-session")).toBeUndefined();
      expect(scenario.response.outcome).toBe("deny");
      expect(unhandled).toEqual([]);
      expect(recordField(recordField(logInput(scenario.fixture), "extra"), "result")).toBe("success");
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });
});
