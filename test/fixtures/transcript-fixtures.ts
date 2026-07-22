export const PARENT_SESSION_ID = "parent-session";
export const CANONICAL_DIRECTORY = "/workspace";

type TextPartFixtureInput = {
  readonly id?: string;
  readonly messageID?: string;
  readonly text?: string;
  readonly synthetic?: boolean;
  readonly ignored?: boolean;
};

export const textPartFixture = (input: TextPartFixtureInput = {}) => ({
  id: input.id ?? "part-text",
  sessionID: PARENT_SESSION_ID,
  messageID: input.messageID ?? "message-user",
  type: "text",
  text: input.text ?? "ordinary context",
  ...(input.synthetic === undefined ? {} : { synthetic: input.synthetic }),
  ...(input.ignored === undefined ? {} : { ignored: input.ignored }),
});

type UserEntryFixtureInput = {
  readonly id?: string;
  readonly created?: number;
  readonly summary?: unknown;
  readonly system?: string;
  readonly parts?: readonly unknown[];
};

export const userEntryFixture = (input: UserEntryFixtureInput = {}) => {
  const id = input.id ?? "message-user";
  return {
    info: {
      id,
      sessionID: PARENT_SESSION_ID,
      role: "user",
      time: { created: input.created ?? 12 },
      agent: "build",
      model: { providerID: "fixture", modelID: "model" },
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      ...(input.system === undefined ? {} : { system: input.system }),
    },
    parts: input.parts ?? [textPartFixture({ messageID: id })],
  };
};

type AssistantEntryFixtureInput = {
  readonly id?: string;
  readonly created?: number;
  readonly cwd?: string;
  readonly summary?: boolean;
  readonly parts?: readonly unknown[];
  readonly error?: unknown;
};

export const assistantEntryFixture = (input: AssistantEntryFixtureInput = {}) => {
  const id = input.id ?? "message-assistant";
  return {
    info: {
      id,
      sessionID: PARENT_SESSION_ID,
      role: "assistant",
      time: { created: input.created ?? 13 },
      parentID: "message-user",
      modelID: "model",
      providerID: "fixture",
      mode: "build",
      path: { cwd: input.cwd ?? CANONICAL_DIRECTORY, root: CANONICAL_DIRECTORY },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      ...(input.error === undefined ? {} : { error: input.error }),
    },
    parts: input.parts ?? [textPartFixture({ id: "part-assistant", messageID: id })],
  };
};

type ToolPartFixtureInput = {
  readonly id: string;
  readonly messageID?: string;
  readonly name?: string;
  readonly status: "pending" | "running" | "completed" | "error";
};

export const toolPartFixture = (input: ToolPartFixtureInput) => ({
  id: input.id,
  sessionID: PARENT_SESSION_ID,
  messageID: input.messageID ?? "message-assistant",
  type: "tool",
  callID: `call-${input.id}`,
  tool: input.name ?? "read",
  state: input.status === "pending"
    ? { status: "pending", input: {}, raw: "{}" }
    : input.status === "running"
      ? { status: "running", input: {}, time: { start: 1 } }
      : input.status === "completed"
        ? {
            status: "completed",
            input: {},
            output: "private output",
            title: "private title",
            metadata: { secret: "private metadata" },
            time: { start: 1, end: 2 },
            attachments: [],
          }
        : { status: "error", input: {}, error: "private error", time: { start: 1, end: 2 } },
});
