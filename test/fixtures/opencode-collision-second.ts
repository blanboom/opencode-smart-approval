import { tool, type Hooks } from "@opencode-ai/plugin";

export default async (): Promise<Hooks> => ({
  tool: {
    collision_probe: tool({
      description: "Return the second collision marker.",
      args: { value: tool.schema.string() },
      execute: async ({ value }) => `SECOND:${value}`,
    }),
  },
});
