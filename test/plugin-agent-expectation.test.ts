import { describe, expect, test } from "bun:test";
import {
  APPROVAL_AGENT_DESCRIPTION,
  APPROVAL_AGENT_NAME,
  APPROVAL_AGENT_PERMISSION_SUFFIX,
  ApprovalAgentContractError,
  validateResolvedApprovalAgent,
} from "../src/approval-agent";
import { createApprovalPluginIntegration } from "../src/index";
import { FakeAnchoredFsAdapter } from "./fixtures/fake-anchored-fs";

const configuredIntegration = (xdgDataHome: string | undefined, homeDirectory: string) => {
  const adapter = new FakeAnchoredFsAdapter();
  adapter.addDirectory("/workspace");
  adapter.addDirectory("/tmp");
  const environment = xdgDataHome === undefined ? {} : { XDG_DATA_HOME: xdgDataHome };
  return createApprovalPluginIntegration(
    { directory: "/workspace", worktree: "/workspace" },
    {
      adapter,
      environment,
      homeDirectory,
      tempDirectory: "/tmp",
      createToolExecuteBefore: () => async () => undefined,
    },
  );
};

const configure = async (xdgDataHome: string | undefined, homeDirectory = "/unused-home") => {
  const integration = configuredIntegration(xdgDataHome, homeDirectory);
  const hook = integration.hooks.config;
  if (!hook) throw new TypeError("missing config hook");
  await hook({});
  return integration;
};

const runtimeAgent = (prompt: string, hostGlob: string) => ({
  name: APPROVAL_AGENT_NAME,
  description: APPROVAL_AGENT_DESCRIPTION,
  mode: "subagent",
  native: false,
  hidden: null,
  topP: null,
  temperature: 0,
  color: null,
  permission: [
    ...APPROVAL_AGENT_PERMISSION_SUFFIX,
    { permission: "external_directory", pattern: hostGlob, action: "allow" },
  ],
  variant: null,
  prompt,
  options: {},
  steps: 4,
});

const contractCode = (operation: () => void): string => {
  try {
    operation();
    return "accepted";
  } catch (error) {
    if (error instanceof ApprovalAgentContractError) return error.code;
    throw error;
  }
};

describe("approval plugin runtime expectation", () => {
  test("derives the trusted host glob from XDG_DATA_HOME using the pinned formula", async () => {
    // Given an isolated process environment with an explicit XDG data home.
    const integration = await configure("/isolated/data");

    // When Todo7 requests the immutable expected-agent seam after the config hook.
    const expected = integration.expectedAgent();
    if (!expected) throw new TypeError("missing runtime expectation");

    // Then the pair contains the exact independently derived OpenCode tool-output glob.
    expect(expected.runtime.toolOutputGlob).toBe("/isolated/data/opencode/tool-output/*");
    expect(Object.isFrozen(expected)).toBe(true);
    expect(Object.isFrozen(expected.runtime)).toBe(true);
    await integration.hooks.dispose?.();
  });

  test("uses xdg-basedir 5.1.0 home fallback when XDG_DATA_HOME is empty", async () => {
    // Given the pinned package's empty-environment fallback and an isolated home string.
    const integration = await configure("", "/isolated/home");

    // When the trusted expectation is retained.
    const expected = integration.expectedAgent();
    if (!expected) throw new TypeError("missing fallback expectation");

    // Then the exact .local/share formula is used without reading filesystem state.
    expect(expected.runtime.toolOutputGlob).toBe("/isolated/home/.local/share/opencode/tool-output/*");
    await integration.hooks.dispose?.();
  });

  test("fails the seam closed when no absolute xdgData value can be derived", async () => {
    // Given neither XDG_DATA_HOME nor a usable home directory.
    const integration = await configure(undefined, "");

    // When the fixed agent config hook completes without a trusted host path.
    const expected = integration.expectedAgent();

    // Then Todo7 receives no expectation pair to validate against runtime self-attestation.
    expect(expected).toBeUndefined();
    await integration.hooks.dispose?.();
  });

  test("passes the exact host glob through the seam and rejects a wrong runtime tail", async () => {
    // Given a trusted pair derived independently from the isolated process environment.
    const integration = await configure("/isolated/data");
    const expected = integration.expectedAgent();
    if (!expected) throw new TypeError("missing runtime expectation");

    // When the exact and a self-asserted different host tail are validated through that pair.
    const accepted = contractCode(() => validateResolvedApprovalAgent(
      [runtimeAgent(expected.config.prompt, expected.runtime.toolOutputGlob)],
      expected.config,
      expected.runtime,
    ));
    const rejected = contractCode(() => validateResolvedApprovalAgent(
      [runtimeAgent(expected.config.prompt, "/wrong/opencode/tool-output/*")],
      expected.config,
      expected.runtime,
    ));

    // Then only the independently computed path is accepted.
    expect({ accepted, rejected }).toEqual({ accepted: "accepted", rejected: "permission_suffix_mismatch" });
    await integration.hooks.dispose?.();
  });
});
