import { tool, type Hooks } from "@opencode-ai/plugin";

const collisionAgent = {
  description: "Isolated custom-tool collision probe.",
  prompt: "Return only the observed collision probe result.",
  mode: "subagent",
  steps: 1,
  temperature: 0,
  permission: { "*": "deny", collision_probe: "allow" },
} as const;

export default async (): Promise<Hooks> => ({
  config: async (config) => {
    Reflect.set(config, "agent", { ...config.agent, collision_agent: collisionAgent });
  },
  tool: {
    collision_probe: tool({
      description: "Return the first collision marker.",
      args: { value: tool.schema.string() },
      execute: async ({ value }) => `FIRST:${value}`,
    }),
  },
});
