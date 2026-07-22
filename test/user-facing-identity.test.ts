import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ApprovalVerdict } from "../src/types";
import {
  isCommandApprovalError,
  renderCommandApprovalError,
  type CommandApprovalError,
} from "../src/user-facing";

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

describe("CommandApprovalError identity", () => {
  test("accepts only the exact factory-created instance", () => {
    // Given one legitimate error and every reflective or structural identity forgery.
    const real = renderedError();
    const prototype = Object.getPrototypeOf(real);
    const reflectedConstructor: unknown = Reflect.get(prototype, "constructor");
    if (typeof reflectedConstructor !== "function") throw new Error("expected reflected constructor");
    const constructorArguments = ["bash", verdict(), "raw-forged-message"];
    class ForgedSubclass extends Error {}
    Object.setPrototypeOf(ForgedSubclass.prototype, prototype);
    const copied = Object.assign(new Error(real.message), {
      name: real.name,
      stack: real.stack,
      tool: real.tool,
      verdict: real.verdict,
    });
    const serialized: unknown = JSON.parse(JSON.stringify({
      name: real.name,
      message: real.message,
      stack: real.stack,
      tool: real.tool,
      verdict: real.verdict,
    }));
    const forgeries: readonly { readonly label: string; readonly value: unknown }[] = [
      { label: "Object.create", value: Object.create(prototype) },
      { label: "Object.setPrototypeOf", value: Object.setPrototypeOf(new Error("raw-set-prototype"), prototype) },
      { label: "reflected constructor", value: Reflect.construct(reflectedConstructor, constructorArguments) },
      { label: "reflected subclass", value: Reflect.construct(reflectedConstructor, constructorArguments, ForgedSubclass) },
      { label: "proxy", value: new Proxy(real, {}) },
      {
        label: "hostile prototype proxy",
        value: new Proxy(real, { getPrototypeOf: () => { throw new Error("raw-prototype-trap"); } }),
      },
      { label: "copied fields", value: copied },
      { label: "structured clone", value: structuredClone(real) },
      { label: "serialized clone", value: serialized },
    ];

    // When the identity guard evaluates the legitimate instance and each forgery.
    const accepted = forgeries.map((candidate) => ({
      label: candidate.label,
      accepted: isCommandApprovalError(candidate.value),
    }));

    // Then membership belongs only to the exact object enrolled by the renderer factory.
    expect(isCommandApprovalError(real)).toBeTrue();
    expect(Object.isFrozen(real)).toBeTrue();
    expect(Reflect.set(real, "message", "raw-mutated-message")).toBeFalse();
    expect(accepted).toEqual(forgeries.map((candidate) => ({ label: candidate.label, accepted: false })));
  });

  test("normalizes a prototype forgery at the real hook catch boundary", () => {
    // Given an isolated driver that makes the decision pipeline throw real and forged errors.
    const driver = join(import.meta.dir, "fixtures", "approval-error-boundary-driver.ts");

    // When the driver invokes the actual tool.execute.before hook boundary.
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", driver],
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });

    // Then only the legitimate object is rethrown and the forged raw body is replaced.
    expect(new TextDecoder().decode(result.stderr)).not.toContain("raw-forged-provider-body");
    expect(result.exitCode).toBe(0);
  });
});
