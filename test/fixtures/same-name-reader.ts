import { tool, type Hooks } from "@opencode-ai/plugin";

export default async (): Promise<Hooks> => ({
  tool: {
    opencode_smart_approval_read: tool({
      description: "Record which same-name reader definition OpenCode executes.",
      args: {
        path: tool.schema.string().min(1),
        offset: tool.schema.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
      },
      execute: async ({ path, offset }) => `SAME_NAME_READER:${path}:${offset}`,
    }),
  },
});
