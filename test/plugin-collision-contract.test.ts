import { describe, expect, test } from "bun:test";
import type { Hooks } from "@opencode-ai/plugin";
import firstPlugin from "./fixtures/opencode-collision-first";
import secondPlugin from "./fixtures/opencode-collision-second";

type ToolDefinition = NonNullable<Hooks["tool"]>[string];
type RegisteredTool = {
  readonly id: string;
  readonly definition: ToolDefinition;
};

const registeredTools = async (
  factories: readonly [typeof firstPlugin, typeof secondPlugin],
): Promise<readonly RegisteredTool[]> => {
  const registered: RegisteredTool[] = [];
  for (const factory of factories) {
    const tools = (await factory()).tool ?? {};
    for (const [id, definition] of Object.entries(tools)) registered.push({ id, definition });
  }
  return registered;
};

const directDebugDefinition = (tools: readonly RegisteredTool[]): ToolDefinition | undefined =>
  tools.find((tool) => tool.id === "collision_probe")?.definition;

const sessionEffectiveDefinition = (tools: readonly RegisteredTool[]): ToolDefinition | undefined => {
  let effective: ToolDefinition | undefined;
  for (const tool of tools) {
    if (tool.id === "collision_probe") effective = tool.definition;
  }
  return effective;
};

describe("same-name custom-tool collision surfaces", () => {
  test("keeps first-then-second registry order while resolving the effective session tool last", async () => {
    // Given two fixture plugins registered in first-then-second configuration order.
    const tools = await registeredTools([firstPlugin, secondPlugin]);

    // When direct-debug selection and session-record assembly consume the ordered definitions.
    const direct = directDebugDefinition(tools);
    const effective = sessionEffectiveDefinition(tools);

    // Then the diagnostic selects first while the effective session record contains second.
    expect(tools.map((tool) => tool.id)).toEqual(["collision_probe", "collision_probe"]);
    expect(tools.map((tool) => tool.definition.description)).toEqual([
      "Return the first collision marker.",
      "Return the second collision marker.",
    ]);
    expect(direct?.description).toBe("Return the first collision marker.");
    expect(effective?.description).toBe("Return the second collision marker.");
  });

  test("keeps second-then-first registry order while resolving the effective session tool last", async () => {
    // Given the same fixture plugins registered in reverse configuration order.
    const tools = await registeredTools([secondPlugin, firstPlugin]);

    // When both host surfaces consume that reversed ordered definition list.
    const direct = directDebugDefinition(tools);
    const effective = sessionEffectiveDefinition(tools);

    // Then the diagnostic selects second while the effective session record contains first.
    expect(tools.map((tool) => tool.id)).toEqual(["collision_probe", "collision_probe"]);
    expect(tools.map((tool) => tool.definition.description)).toEqual([
      "Return the second collision marker.",
      "Return the first collision marker.",
    ]);
    expect(direct?.description).toBe("Return the second collision marker.");
    expect(effective?.description).toBe("Return the first collision marker.");
  });
});
