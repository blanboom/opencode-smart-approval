import { expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalVerdict } from "../../src/types";
import {
  isCommandApprovalError,
  renderCommandApprovalError,
  type CommandApprovalError,
} from "../../src/user-facing";

let pipelineError: unknown = new Error("pipeline error not initialized");

mock.module("../../src/decision-pipeline", () => ({
  resolveCommandVerdict: async () => {
    throw pipelineError;
  },
}));

const { createHook } = await import("../../src/index");

const verdict = (): ApprovalVerdict => ({
  decision: "block",
  source: "fail_closed",
  reasonSource: "provider",
  riskLevel: "high",
  userAuthorization: "unknown",
  categories: [],
  reasons: ["provider_failure:unavailable"],
  matchedRuleLabels: [],
});

const renderedError = (): CommandApprovalError => {
  const rendered = renderCommandApprovalError({ kind: "ordinary", tool: "bash", verdict: verdict() });
  if (rendered.kind === "error") return rendered.error;
  throw new Error("expected ordinary approval error");
};

test("hook rethrows only authentic approval errors", async () => {
  // Given a hook, a renderer-created error, and a raw Error with the authentic prototype.
  const root = mkdtempSync(join(tmpdir(), "approval-error-boundary-"));
  const project = join(root, "project");
  const previousXdg = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = join(root, "xdg");
  try {
    const hook = createHook(project);
    const real = renderedError();
    const forged = Object.setPrototypeOf(new Error("raw-forged-provider-body\u001B]52;c;YQ==\u0007"), Object.getPrototypeOf(real));
    const invoke = () => hook(
      { tool: "bash", sessionID: "identity", callID: "identity-call" },
      { args: { command: "unknown-command" } },
    );

    // When the real error and then the forged error cross the actual index catch boundary.
    pipelineError = real;
    await expect(invoke()).rejects.toBe(real);
    pipelineError = forged;
    let caught: unknown;
    try {
      await invoke();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      caught = error;
    }

    // Then the forged raw body is not rethrown and only a newly rendered fixed error escapes.
    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) return;
    expect(caught).not.toBe(forged);
    expect(caught.message).not.toContain("raw-forged-provider-body");
    expect(caught.message).toContain("reason=parser: parser_failure:unavailable");
    expect(isCommandApprovalError(caught)).toBeTrue();
  } finally {
    if (previousXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = previousXdg;
    rmSync(root, { recursive: true, force: true });
  }
});
