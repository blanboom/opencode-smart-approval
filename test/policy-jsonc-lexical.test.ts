import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadOrInitializePolicy, POLICY_FILE_NAME } from "../src/config";
import { tempDir, withXdg, writeGlobalPolicy, xdgConfigHome } from "./policy-test-helpers";

const MINIMAL_V3 = '{"version":3,"review":{}}';

const unterminatedComments = [
  ["prefix", `/* unterminated\n${MINIMAL_V3}`],
  ["middle", '{"version":3,/* unterminated'],
  ["trailing", `${MINIMAL_V3} /* unterminated`],
  ["newline", `${MINIMAL_V3} /* line one\nline two`],
  ["nested-looking", `${MINIMAL_V3} /* outer /* inner`],
  ["EOF after star", `${MINIMAL_V3} /* unterminated *`],
  ["after escaped string", `${JSON.stringify({ version: 3, review: { prompt: 'policy-id:\\"/*literal' } })} /* open`],
] as const;

describe("policy JSONC lexical boundary", () => {
  test.each(unterminatedComments)("fails closed for an unterminated block comment at %s", (_label, source) => {
    // Given one existing v3 JSONC file with an unterminated block comment.
    const directory = tempDir();
    const observed = withXdg(() => {
      writeGlobalPolicy(source);
      const path = join(xdgConfigHome(), "opencode", POLICY_FILE_NAME);

      // When the real loader parses the file.
      const loaded = loadOrInitializePolicy(directory);
      return {
        contents: readFileSync(path, "utf8"),
        files: readdirSync(join(xdgConfigHome(), "opencode")),
        loaded,
        path,
      };
    });

    // Then loading fails without replacing, normalizing, or supplementing its bytes.
    expect(observed.loaded.ok).toBe(false);
    expect(observed.loaded.path).toBe(observed.path);
    expect(observed.loaded.initialized).toBe(false);
    expect(observed.contents).toBe(source);
    expect(observed.files).toEqual([POLICY_FILE_NAME]);
  });

  test.each([
    ["slash tokens in a string", { prompt: "policy-id:/*literal*/ // still-string" }],
    ["escaped quote before slash tokens", { prompt: 'policy-id:\\"/*literal*/' }],
    ["escaped backslash before slash tokens", { prompt: "policy-id:\\\\/*literal*/" }],
  ] as const)("preserves %s", (_label, review) => {
    // Given slash-like comment tokens contained entirely in a JSON string.
    const directory = tempDir();
    const source = `${JSON.stringify({ version: 3, review })} // terminated line comment\n`;

    // When the real loader parses the string-aware JSONC source.
    const loaded = withXdg(() => {
      writeGlobalPolicy(source);
      return loadOrInitializePolicy(directory);
    });

    // Then the string survives and the terminated line comment is ignored.
    expect(loaded.ok).toBe(true);
    expect(loaded.policy.review.prompt).toBe(review.prompt);
  });
});
