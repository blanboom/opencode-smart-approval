import { describe, expect, test } from "bun:test";
import { buildChildEnvironment, type HarnessDirectories } from "../scripts/opencode-e2e/environment";
import { parseHealthReceipt, parseStartupReceipt } from "../scripts/opencode-e2e/startup";

const directories: HarnessDirectories = {
  root: "/private/tmp/harness",
  home: "/private/tmp/harness/home",
  config: "/private/tmp/harness/config",
  data: "/private/tmp/harness/data",
  cache: "/private/tmp/harness/cache",
  state: "/private/tmp/harness/state",
  tmp: "/private/tmp/harness/tmp",
  workspace: "/private/tmp/harness/workspace",
  database: "/private/tmp/harness/database/opencode.db",
};

describe("isolated OpenCode environment", () => {
  test("builds the exact boot-only child environment from explicit inputs", () => {
    // Given isolated paths, stable config, and a harness-owned closed proxy port.
    const input = { directories, configContent: "{\"model\":\"openai/fixture-primary\"}", closedProxyPort: 43123, disableDefaultPlugins: true };

    // When the child environment is constructed.
    const environment = buildChildEnvironment(input);

    // Then only the exact isolation, feature-disable, proxy, and boot-only keys are present.
    expect(Object.keys(environment).sort()).toEqual([
      "ALL_PROXY", "HOME", "HTTPS_PROXY", "HTTP_PROXY", "LANG", "LC_ALL", "NO_PROXY",
      "OPENCODE_AUTH_CONTENT", "OPENCODE_AUTO_SHARE", "OPENCODE_CONFIG_CONTENT", "OPENCODE_DB",
      "OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_DISABLE_CLAUDE_CODE", "OPENCODE_DISABLE_DEFAULT_PLUGINS",
      "OPENCODE_DISABLE_EMBEDDED_WEB_UI", "OPENCODE_DISABLE_EXTERNAL_SKILLS", "OPENCODE_DISABLE_LSP_DOWNLOAD",
      "OPENCODE_DISABLE_MODELS_FETCH", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_DISABLE_PRUNE",
      "OPENCODE_DISABLE_SHARE", "OPENCODE_ENABLE_EXA", "OPENCODE_ENABLE_QUESTION_TOOL", "PATH", "TMPDIR",
      "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "all_proxy", "http_proxy",
      "https_proxy", "no_proxy",
    ].sort());
    expect(environment["OPENCODE_DISABLE_DEFAULT_PLUGINS"]).toBe("true");
    expect(environment["OPENCODE_PURE"]).toBeUndefined();
    expect(environment["HOME"]).toBe(directories.home);
    expect(environment["OPENCODE_DB"]).toBe(directories.database);
  });

  test("omits the boot-only flag from inference children", () => {
    // Given the same isolated paths for an inference process.
    const input = { directories, configContent: "{}", closedProxyPort: 43123, disableDefaultPlugins: false };

    // When its environment is constructed.
    const environment = buildChildEnvironment(input);

    // Then default plugins are enabled by omission rather than a false alias.
    expect(environment["OPENCODE_DISABLE_DEFAULT_PLUGINS"]).toBeUndefined();
  });
});

describe("OpenCode startup receipts", () => {
  test("accepts exactly one loopback startup line", () => {
    // Given the pinned serve startup output.
    const stdout = "opencode server listening on http://127.0.0.1:43124\n";

    // When the receipt is parsed.
    const receipt = parseStartupReceipt(stdout);

    // Then the exact origin and port are retained.
    expect(receipt).toEqual({ origin: "http://127.0.0.1:43124", port: 43124 });
  });

  test("rejects duplicate or non-loopback startup lines", () => {
    // Given ambiguous and externally bound startup output.
    const duplicate = "opencode server listening on http://127.0.0.1:43124\nopencode server listening on http://127.0.0.1:43125\n";

    // When each output is parsed.
    const duplicateCall = () => parseStartupReceipt(duplicate);
    const externalCall = () => parseStartupReceipt("opencode server listening on http://0.0.0.0:43124\n");

    // Then both fail closed at the startup boundary.
    expect(duplicateCall).toThrow("startup");
    expect(externalCall).toThrow("startup");
  });

  test("accepts only the pinned strict health payload", () => {
    // Given the exact health object and a shape with an extra field.
    const valid = { healthy: true, version: "1.17.14" } as const;

    // When the health boundary parses both shapes.
    const parsed = parseHealthReceipt(valid);
    const extraCall = () => parseHealthReceipt({ ...valid, owner: "/Users/owner" });

    // Then only the exact pinned health shape survives.
    expect(parsed).toEqual(valid);
    expect(extraCall).toThrow("health");
  });
});
