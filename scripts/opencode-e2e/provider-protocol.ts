import type { JsonValue } from "../../src/stable-json";
import { HarnessContractError } from "./errors";
import { z } from "zod";

export type ProviderRequest = {
  readonly model: string;
  readonly input: readonly JsonValue[];
  readonly tools: readonly JsonValue[];
  readonly stream: true;
};

const ProviderRequestSchema = z.object({
  background: z.json().optional(),
  frequency_penalty: z.json().optional(),
  include: z.json().optional(),
  model: z.string().min(1),
  input: z.array(z.json()),
  instructions: z.json().optional(),
  max_output_tokens: z.json().optional(),
  max_tool_calls: z.json().optional(),
  metadata: z.json().optional(),
  parallel_tool_calls: z.json().optional(),
  presence_penalty: z.json().optional(),
  previous_response_id: z.json().optional(),
  prompt_cache_key: z.json().optional(),
  prompt_cache_retention: z.json().optional(),
  reasoning: z.json().optional(),
  safety_identifier: z.json().optional(),
  service_tier: z.json().optional(),
  store: z.json().optional(),
  tools: z.array(z.json()),
  tool_choice: z.json().optional(),
  temperature: z.json().optional(),
  text: z.json().optional(),
  top_logprobs: z.json().optional(),
  top_p: z.json().optional(),
  truncation: z.json().optional(),
  user: z.json().optional(),
  stream: z.literal(true),
}).strict();

const usage = {
  input_tokens: 1,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 1,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 2,
} as const;

const response = (id: string, status: "in_progress" | "completed", output: readonly JsonValue[]): JsonValue => ({
  id,
  object: "response",
  created_at: 1,
  status,
  error: null,
  incomplete_details: null,
  instructions: null,
  max_output_tokens: 4096,
  model: "fixture",
  output,
  parallel_tool_calls: false,
  previous_response_id: null,
  reasoning: { effort: null, summary: null },
  store: false,
  temperature: 0,
  text: { format: { type: "text" } },
  tool_choice: "auto",
  tools: [],
  top_p: 1,
  truncation: "disabled",
  usage: status === "completed" ? usage : null,
  user: null,
  metadata: {},
});

const isJsonObject = (input: JsonValue): input is { readonly [key: string]: JsonValue } => (
  typeof input === "object" && input !== null && !Array.isArray(input)
);

export const parseProviderRequest = (authorization: string | null, input: unknown): ProviderRequest => {
  const parsed = ProviderRequestSchema.safeParse(input);
  if (authorization !== "Bearer fixture-key" || !parsed.success) throw new HarnessContractError("provider_request");
  return Object.freeze({
    model: parsed.data.model,
    input: Object.freeze(parsed.data.input),
    tools: Object.freeze(parsed.data.tools),
    stream: true,
  });
};

export const functionCallEvents = (
  responseId: string,
  callId: string,
  name: string,
  argumentsJson: string,
): readonly JsonValue[] => {
  const itemId = `item-${callId}`;
  const added = { id: itemId, type: "function_call", call_id: callId, name, arguments: "", status: "in_progress" } as const;
  const done = { ...added, arguments: argumentsJson, status: "completed" } as const;
  return Object.freeze([
    { type: "response.created", response: response(responseId, "in_progress", []), sequence_number: 0 },
    { type: "response.output_item.added", item: added, output_index: 0, sequence_number: 1 },
    { type: "response.function_call_arguments.delta", item_id: itemId, output_index: 0, delta: argumentsJson, sequence_number: 2 },
    { type: "response.function_call_arguments.done", item_id: itemId, output_index: 0, arguments: argumentsJson, sequence_number: 3 },
    { type: "response.output_item.done", item: done, output_index: 0, sequence_number: 4 },
    { type: "response.completed", response: response(responseId, "completed", [done]), sequence_number: 5 },
  ]);
};

export const finalTextEvents = (responseId: string, messageId: string, text: string): readonly JsonValue[] => {
  const added = { id: messageId, type: "message", status: "in_progress", role: "assistant", content: [] } as const;
  const part = { type: "output_text", annotations: [], logprobs: [], text } as const;
  const done = { ...added, status: "completed", content: [part] } as const;
  return Object.freeze([
    { type: "response.created", response: response(responseId, "in_progress", []), sequence_number: 0 },
    { type: "response.output_item.added", item: added, output_index: 0, sequence_number: 1 },
    { type: "response.content_part.added", item_id: messageId, output_index: 0, content_index: 0, part: { ...part, text: "" }, sequence_number: 2 },
    { type: "response.output_text.delta", item_id: messageId, output_index: 0, content_index: 0, delta: text, logprobs: [], sequence_number: 3 },
    { type: "response.output_text.done", item_id: messageId, output_index: 0, content_index: 0, text, logprobs: [], sequence_number: 4 },
    { type: "response.content_part.done", item_id: messageId, output_index: 0, content_index: 0, part, sequence_number: 5 },
    { type: "response.output_item.done", item: done, output_index: 0, sequence_number: 6 },
    { type: "response.completed", response: response(responseId, "completed", [done]), sequence_number: 7 },
  ]);
};

export const responseEventTypes = (events: readonly JsonValue[]): readonly string[] => Object.freeze(events.map((event) => {
  if (!isJsonObject(event) || typeof event["type"] !== "string") {
    throw new HarnessContractError("provider_stream");
  }
  return event["type"];
}));

export const encodeServerSentEvents = (events: readonly JsonValue[]): string => {
  const types = responseEventTypes(events);
  return `${events.map((event, index) => `event: ${types[index] ?? ""}\ndata: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
};
