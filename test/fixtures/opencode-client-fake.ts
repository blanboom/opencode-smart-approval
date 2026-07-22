import type {
  AbortOptions,
  AgentsOptions,
  ApprovalRootClient,
  CreateOptions,
  DeleteOptions,
  LogOptions,
  MessagesOptions,
  PromptOptions,
} from "../../src/opencode-client-adapter";

export type FakeMethod = "agents" | "messages" | "create" | "prompt" | "abort" | "delete" | "log";
export type FakeCall = { readonly method: FakeMethod; readonly options: unknown };

export type FakeClient = {
  readonly client: ApprovalRootClient;
  readonly calls: readonly FakeCall[];
};

export const fakeClient = (run: (method: FakeMethod, options: unknown) => Promise<unknown>): FakeClient => {
  const calls: FakeCall[] = [];
  const invoke = (method: FakeMethod, options: unknown): Promise<unknown> => {
    calls.push({ method, options });
    return run(method, options);
  };
  return {
    client: {
      app: {
        agents: (options: AgentsOptions) => invoke("agents", options),
        log: (options: LogOptions) => invoke("log", options),
      },
      session: {
        messages: (options: MessagesOptions) => invoke("messages", options),
        create: (options: CreateOptions) => invoke("create", options),
        prompt: (options: PromptOptions) => invoke("prompt", options),
        abort: (options: AbortOptions) => invoke("abort", options),
        delete: (options: DeleteOptions) => invoke("delete", options),
      },
    },
    calls,
  };
};
