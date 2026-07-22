import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import approvalPlugin from "../src/index";
import { fakeClient } from "./fixtures/opencode-client-fake";

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-smart-approval-integration-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("approval plugin integration", () => {
  test("rejects production startup without the plugin-supplied root client", async () => {
    // Given a real workspace but no OpenCode root client at the production entry boundary.
    const directory = makeTemporaryDirectory();

    // When the exported server entry is started without its required client.
    const startup = approvalPlugin.server({ directory });

    // Then startup fails with one stable machine-readable input category.
    await expect(startup).rejects.toMatchObject({ name: "PluginInputError", code: "client_unavailable" });
  });

  test("publishes the official config, tool, disposal, and command approval hooks", async () => {
    // Given an initialized plugin instance rooted in an isolated workspace.
    const directory = makeTemporaryDirectory();
    const xdgConfig = makeTemporaryDirectory();
    const previousXdg = process.env["XDG_CONFIG_HOME"];
    mkdirSync(join(xdgConfig, "opencode"), { recursive: true });
    writeFileSync(join(xdgConfig, "opencode", "command-approval.jsonc"), JSON.stringify({ version: 3, review: {} }));

    // When its public server entry point constructs the OpenCode hook map.
    process.env["XDG_CONFIG_HOME"] = xdgConfig;
    let hooks: Awaited<ReturnType<NonNullable<typeof approvalPlugin.server>>>;
    try {
      hooks = await approvalPlugin.server({ directory, client: fakeClient(async () => ({ data: true })).client });
    } finally {
      if (previousXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = previousXdg;
    }

    // Then the new approval-agent lifecycle is present without replacing the existing hook.
    expect(Object.keys(hooks).sort()).toEqual(["config", "dispose", "event", "tool", "tool.execute.before"]);
    await hooks.dispose?.();
  });

});
