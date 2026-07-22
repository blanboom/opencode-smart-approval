import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVAL_AGENT_NAME, registerApprovalAgent } from "../src/approval-agent";
import { loadOrInitializePolicy, POLICY_FILE_NAME } from "../src/config";
import { parsePolicyJsonc, policyDocumentFromUnknown } from "../src/policy-parser";
import { tempDir, withXdg, writeGlobalPolicy, writeLocalPolicy, xdgConfigHome } from "./policy-test-helpers";

const packageRoot = join(import.meta.dir, "..");
const readmePaths = ["README.md", "README.zh-CN.md"] as const;

type ReadmePolicyExample = {
  readonly file: (typeof readmePaths)[number];
  readonly language: string;
  readonly kind: string;
  readonly category: string | undefined;
  readonly body: string;
};

const readmePolicyExamples = (file: (typeof readmePaths)[number]): readonly ReadmePolicyExample[] => {
  const markdown = readFileSync(join(packageRoot, file), "utf8");
  return [...markdown.matchAll(/^```(jsonc?)([^\r\n]*)\r?\n([\s\S]*?)^```[ \t]*$/gmu)].map((match) => {
    const metadata = (match[2] ?? "").trim().split(/\s+/u).filter((field) => field.length > 0);
    return Object.freeze({
      file,
      language: match[1] ?? "",
      kind: metadata[0] ?? "",
      category: metadata[1],
      body: match[3] ?? "",
    });
  });
};

const examplesByReadme = readmePaths.map((file) => readmePolicyExamples(file));
const documentedExamples = examplesByReadme.flat();

const policyCategory = (body: string): string => {
  try {
    policyDocumentFromUnknown(parsePolicyJsonc(body), []);
    return "accepted";
  } catch (error) {
    if (error instanceof Error) return error.message.split(":", 1)[0] ?? "unknown";
    throw error;
  }
};

describe("policy document validation", () => {
  test("keeps the English and Chinese policy examples in exact structural parity", () => {
    // Given both shipped README files and every machine-tagged JSON or JSONC fence.
    const [english, chinese] = examplesByReadme;

    // When the documentation example inventories are reduced to parser inputs.
    const comparable = (examples: readonly ReadmePolicyExample[]) => examples.map((example) => ({
      language: example.language,
      kind: example.kind,
      category: example.category,
      body: example.body,
    }));

    // Then both languages publish the same valid v3 and explicit removed-v2 examples.
    expect(english).toBeDefined();
    expect(chinese).toBeDefined();
    expect(comparable(english ?? [])).toEqual(comparable(chinese ?? []));
    expect((english ?? []).map((example) => [example.language, example.kind, example.category])).toEqual([
      ["jsonc", "policy-v3", undefined],
      ["jsonc", "removed-v2", "version"],
    ]);
  });

  test.each(documentedExamples)("parses $file $kind through the strict v3 boundary", (example) => {
    // Given one extracted README policy fence classified by machine-readable metadata.
    // When the real JSONC and strict policy parsers consume it.
    const category = policyCategory(example.body);

    // Then valid v3 is accepted and the documented removed shape fails at its exact category.
    const expectedCategory = example.kind === "policy-v3" ? "accepted" : example.category;
    if (!expectedCategory) throw new Error(`missing expected category for ${example.kind}`);
    expect(category).toBe(expectedCategory);
  });

  test("loads the documented minimal v3 and registers its fixed approval agent", () => {
    // Given the English minimal v3 fence and an isolated OpenCode small model.
    const example = examplesByReadme[0]?.find((candidate) => candidate.kind === "policy-v3");
    if (!example) throw new Error("missing documented policy-v3 example");
    const directory = tempDir();

    // When the real file loader and fixed-agent registration consume the documented input.
    const result = withXdg(() => {
      writeGlobalPolicy(example.body);
      const loaded = loadOrInitializePolicy(directory);
      if (!loaded.ok) throw new Error("documented policy-v3 example failed to load");
      const config: Record<string, unknown> = { small_model: "docs-provider/docs-small" };
      const agent = registerApprovalAgent(config, loaded.policy.review.prompt, loaded.policy.review.model);
      return { agent, configured: Reflect.get(config, "agent") };
    });

    // Then the documented fallback model and fixed restricted identity reach the debug-agent surface.
    expect(result.agent).toMatchObject({
      mode: "subagent",
      steps: 4,
      temperature: 0,
      model: "docs-provider/docs-small",
      permission: {
        "*": "deny",
        external_directory: "deny",
        opencode_smart_approval_read: "allow",
      },
    });
    expect(result.configured).toMatchObject({ [APPROVAL_AGENT_NAME]: result.agent });
  });

  test("keeps the trusted global policy when delegation has no local file", () => {
    // Given valid global delegation without a local document.
    const directory = tempDir();

    // When policy resolution completes.
    const loaded = withXdg(() => {
      writeGlobalPolicy({ allow_local_config: true, review: { model: "global/reviewer" } });
      return {
        result: loadOrInitializePolicy(directory),
        globalPath: join(xdgConfigHome(), "opencode", POLICY_FILE_NAME),
      };
    });

    // Then the validated global policy remains active.
    expect(loaded.result.ok).toBe(true);
    expect(loaded.result.path).toBe(loaded.globalPath);
    expect(loaded.result.policy.review.model).toBe("global/reviewer");
  });

  test("fails closed when an opted-in local policy has an invalid present model", () => {
    // Given trusted delegation to a local policy with an invalid present model.
    const directory = tempDir();
    writeLocalPolicy(directory, { review: { model: "" } });

    // When the delegated document is validated.
    const loaded = withXdg(() => {
      writeGlobalPolicy({ allow_local_config: true });
      return loadOrInitializePolicy(directory);
    });

    // Then validation fails at the local policy path without fallback.
    expect(loaded.ok).toBe(false);
    expect(loaded.path).toBe(join(directory, POLICY_FILE_NAME));
    if (loaded.ok) throw new Error("expected local policy validation to fail");
    expect(loaded.error).toContain("review.model");
  });

  test.each([
    ["global", false],
    ["delegated local", true],
  ])("rejects an array as the %s policy document", (_label, local) => {
    // Given syntactically valid JSON with the wrong document shape.
    const directory = tempDir();
    if (local) writeLocalPolicy(directory, "[]");

    // When the selected document is loaded.
    const loaded = withXdg(() => {
      if (local) writeGlobalPolicy({ allow_local_config: true });
      else writeGlobalPolicy("[]");
      return loadOrInitializePolicy(directory);
    });

    // Then loading fails closed at the selected path.
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error("expected policy validation to fail");
    expect(loaded.error).toContain("policy");
  });
});
