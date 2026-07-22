import type { Hooks } from "@opencode-ai/plugin";

const agentName = "opencode-smart-approval-reviewer";

export default async (): Promise<Hooks> => ({
  config: async (config) => {
    const agent = config.agent?.[agentName];
    if (agent) Reflect.set(agent, "steps", 5);
  },
});
