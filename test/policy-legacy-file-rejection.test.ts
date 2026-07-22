import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadOrInitializePolicy, POLICY_FILE_NAME } from "../src/config";
import { tempDir, withXdg, writeGlobalPolicy, xdgConfigHome } from "./policy-test-helpers";

describe("legacy policy rejection", () => {
  test("rejects the legacy global JSON filename without generating JSONC", () => {
    // Given only a retired global JSON policy filename.
    const directory = tempDir();

    // When policy resolution encounters it.
    const loaded = withXdg(() => {
      const legacyPath = join(xdgConfigHome(), "opencode", "command-approval.json");
      const jsoncPath = join(xdgConfigHome(), "opencode", POLICY_FILE_NAME);
      writeFileSync(legacyPath, JSON.stringify({ version: 3, review: {} }));
      return { result: loadOrInitializePolicy(directory), legacyPath, jsoncExists: existsSync(jsoncPath) };
    });

    // Then the filename fails closed without compatibility loading or replacement.
    expect(loaded.result.ok).toBe(false);
    expect(loaded.result.path).toBe(loaded.legacyPath);
    expect(loaded.jsoncExists).toBe(false);
  });

  test("rejects the legacy local JSON filename after trusted delegation", () => {
    // Given a trusted delegation and only a retired local filename.
    const directory = tempDir();
    const legacyPath = join(directory, "command-approval.json");
    writeFileSync(legacyPath, JSON.stringify({ version: 3, review: {} }));

    // When the local policy is selected.
    const loaded = withXdg(() => {
      writeGlobalPolicy({ allow_local_config: true });
      return loadOrInitializePolicy(directory);
    });

    // Then selection fails closed at the retired path.
    expect(loaded.ok).toBe(false);
    expect(loaded.path).toBe(legacyPath);
    expect(existsSync(join(directory, POLICY_FILE_NAME))).toBe(false);
  });

  test("rejects the retired risk_tool top-level alias", () => {
    // Given a v3 document containing the retired alias.
    const directory = tempDir();

    // When it is loaded through the real boundary.
    const loaded = withXdg(() => {
      writeGlobalPolicy({ risk_tool: { enabled: false } });
      return loadOrInitializePolicy(directory);
    });

    // Then strict loading names the obsolete field and fails closed.
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error("expected obsolete alias rejection");
    expect(loaded.error).toContain("risk_tool");
  });
});
