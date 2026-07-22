import { HarnessContractError } from "./errors";
import { stableJsonStringify } from "../../src/stable-json";

export type ModelRoute = "explicit" | "small" | "inherited" | "fault" | "hang";

export type HarnessConfigInput = {
  readonly providerOrigin: string;
  readonly pluginUrl: string;
  readonly laterPluginUrl?: string;
  readonly modelRoute: ModelRoute;
  readonly cleanupSession: boolean;
};

export type HarnessConfigDocuments = {
  readonly opencode: string;
  readonly policy: string;
};

const modelIds = ["fixture-primary", "fixture-reviewer", "fixture-explicit", "fixture-fault", "fixture-hang"] as const;

const modelConfig = (id: string) => ({
  name: id,
  reasoning: false,
  temperature: true,
  tool_call: true,
  limit: { context: 32_768, output: 4_096 },
  modalities: { input: ["text"], output: ["text"] },
});

const assertNever = (route: never): never => {
  void route;
  throw new HarnessContractError("environment");
};

const routeModels = (route: ModelRoute): { readonly policyModel?: string; readonly smallModel?: string } => {
  switch (route) {
    case "explicit":
      return { policyModel: "openai/fixture-explicit", smallModel: "openai/fixture-reviewer" };
    case "small":
      return { smallModel: "openai/fixture-reviewer" };
    case "inherited":
      return {};
    case "fault":
      return { policyModel: "openai/fixture-fault", smallModel: "openai/fixture-reviewer" };
    case "hang":
      return { policyModel: "openai/fixture-hang", smallModel: "openai/fixture-reviewer" };
    default:
      return assertNever(route);
  }
};

export const buildHarnessConfigDocuments = (input: HarnessConfigInput): HarnessConfigDocuments => {
  if (!URL.canParse(input.providerOrigin) || !input.pluginUrl.startsWith("file://")) {
    throw new HarnessContractError("environment");
  }
  if (input.laterPluginUrl !== undefined && !input.laterPluginUrl.startsWith("file://")) {
    throw new HarnessContractError("environment");
  }
  const provider = new URL(input.providerOrigin);
  if (provider.protocol !== "http:" || provider.hostname !== "127.0.0.1" || provider.pathname !== "/v1") {
    throw new HarnessContractError("environment");
  }
  const route = routeModels(input.modelRoute);
  const plugins = input.laterPluginUrl === undefined ? [input.pluginUrl] : [input.pluginUrl, input.laterPluginUrl];
  const opencode = {
    enabled_providers: ["openai"],
    model: "openai/fixture-primary",
    ...(route.smallModel === undefined ? {} : { small_model: route.smallModel }),
    provider: {
      openai: {
        npm: "@ai-sdk/openai",
        options: { apiKey: "fixture-key", baseURL: input.providerOrigin },
        models: Object.fromEntries(modelIds.map((id) => [id, modelConfig(id)])),
      },
    },
    plugin: plugins,
  };
  const policy = {
    version: 3,
    review: {
      timeout_ms: 10_000,
      context_messages: 20,
      cleanup_session: input.cleanupSession,
      ...(route.policyModel === undefined ? {} : { model: route.policyModel }),
    },
    tirith: { enabled: false },
    self_protection: { enabled: true },
    rules: { review: [{ match: ".*", reason: "fixture review", scope: "command", priority: 100 }] },
  };
  const opencodeJson = stableJsonStringify(opencode);
  const policyJson = stableJsonStringify(policy);
  if (!opencodeJson.ok || !policyJson.ok) throw new HarnessContractError("environment");
  return Object.freeze({ opencode: opencodeJson.value, policy: policyJson.value });
};
