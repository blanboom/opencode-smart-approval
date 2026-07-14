import {
  DEFAULT_REVIEW_CONNECTION,
  DEFAULT_REVIEW_MAX_RETRIES,
  DEFAULT_RISK_TOOL,
} from "./default-config";
import { DEFAULT_REVIEWER_POLICY } from "./prompt";
import { isLegacyGeneratedRule } from "./legacy-generated-rules";
import { compileRule, ruleIdentity } from "./rule-compiler";
import type {
  ApprovalPolicy,
  CommandRule,
  ReviewConfig,
  RiskToolConfig,
  RuleDecision,
  RuleScope,
} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const stripJsonComments = (text: string): string => {
  let output = "";
  let index = 0;
  let inString = false;
  let escaped = false;
  while (index < text.length) {
    const char = text.charAt(index);
    const next = text.charAt(index + 1);
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      index += 2;
      while (index < text.length && text.charAt(index) !== "\n") index += 1;
      if (index < text.length) output += "\n";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text.charAt(index) === "*" && text.charAt(index + 1) === "/")) {
        if (text.charAt(index) === "\n") output += "\n";
        index += 1;
      }
      index += 2;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
};

export const parsePolicyJsonc = (text: string): unknown => {
  return JSON.parse(stripJsonComments(text));
};

const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const numberField = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const optionalNumberField = (record: Record<string, unknown>, key: string, label: string): number | undefined => {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`${label} must be an integer between 0 and 10`);
};

const booleanField = (record: Record<string, unknown>, key: string): boolean | undefined => {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
};

const isValidUrl = (value: string): boolean => {
  try {
    new URL(value);
    return true;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
};

const ruleFromUnknown = (value: unknown, decision: RuleDecision, index: number): CommandRule => {
  const label = `${decision}[${String(index)}]`;
  if (typeof value === "string" && value.length > 0) {
    return compileRule({ label, match: value, decision, origin: "user" });
  }
  if (!isRecord(value)) throw new Error("rule must be a regex string or an object");
  const match = stringField(value, "match");
  const reason = stringField(value, "reason");
  if (!match) throw new Error("rule object requires match");
  const rawScope = value["scope"];
  if (rawScope !== undefined && rawScope !== "command" && rawScope !== "segment") {
    throw new Error("rule.scope must be command or segment");
  }
  const scope: RuleScope = rawScope ?? "command";
  const rawPriority = value["priority"];
  if (rawPriority !== undefined && (typeof rawPriority !== "number" || !Number.isSafeInteger(rawPriority))) {
    throw new Error("rule.priority must be a safe integer");
  }
  const priority = rawPriority ?? 0;
  return compileRule({
    label,
    match,
    decision,
    scope,
    priority,
    origin: "user",
    ...(reason ? { reason } : {}),
  });
};

const ruleListFromUnknown = (
  value: unknown,
  decision: RuleDecision,
  retireLegacyGenerated: boolean,
): readonly CommandRule[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`policy.rules.${decision} must be an array`);
  return value
    .filter((rule) => !(retireLegacyGenerated && typeof rule === "string" && isLegacyGeneratedRule(decision, rule)))
    .map((rule, index) => ruleFromUnknown(rule, decision, index));
};

const mergeRules = (
  userRules: readonly CommandRule[],
  fallbackRules: readonly CommandRule[],
): readonly CommandRule[] => {
  const identities = new Set<string>();
  const merged: CommandRule[] = [];
  for (const rule of [...userRules, ...fallbackRules]) {
    const identity = ruleIdentity(rule);
    if (identities.has(identity)) continue;
    identities.add(identity);
    merged.push(rule);
  }
  return merged;
};

const rulesFromUnknown = (value: unknown, retireLegacyGenerated: boolean): readonly CommandRule[] => {
  if (!isRecord(value)) return [];
  const userRules = [
    ...ruleListFromUnknown(value["block"], "block", retireLegacyGenerated),
    ...ruleListFromUnknown(value["review"], "review", retireLegacyGenerated),
    ...ruleListFromUnknown(value["allow"], "allow", retireLegacyGenerated),
  ];
  return userRules;
};

const reviewFromUnknown = (value: unknown): ReviewConfig => {
  if (!isRecord(value)) {
    return {
      ...DEFAULT_REVIEW_CONNECTION,
      timeoutMs: 45_000,
      maxScriptBytes: 20_000,
      maxToolCalls: 3,
      maxRetries: DEFAULT_REVIEW_MAX_RETRIES,
      contextMessages: 20,
      prompt: DEFAULT_REVIEWER_POLICY,
    };
  }
  const baseURL = stringField(value, "base_url") ?? stringField(value, "baseURL") ?? DEFAULT_REVIEW_CONNECTION.baseURL;
  const apiKey = stringField(value, "api_key") ?? stringField(value, "apiKey") ?? DEFAULT_REVIEW_CONNECTION.apiKey;
  const model = stringField(value, "model") ?? DEFAULT_REVIEW_CONNECTION.model;
  const timeoutMs = numberField(value, "timeout_ms") ?? numberField(value, "timeoutMs") ?? 45_000;
  const maxScriptBytes =
    numberField(value, "max_script_bytes") ?? numberField(value, "maxScriptBytes") ?? 20_000;
  const maxToolCalls = numberField(value, "max_tool_calls") ?? 3;
  const maxRetries =
    optionalNumberField(value, "max_retries", "review.max_retries") ??
    optionalNumberField(value, "maxRetries", "review.max_retries") ??
    DEFAULT_REVIEW_MAX_RETRIES;
  const contextMessages = numberField(value, "context_messages") ?? 20;
  const prompt = stringField(value, "prompt") ?? DEFAULT_REVIEWER_POLICY;
  if (!isValidUrl(baseURL)) {
    throw new Error("review.base_url must be a valid URL");
  }
  if (timeoutMs < 5_000 || timeoutMs > 300_000) {
    throw new Error("review.timeout_ms must be between 5000 and 300000");
  }
  if (maxScriptBytes < 0 || maxScriptBytes > 200_000) {
    throw new Error("review.max_script_bytes must be between 0 and 200000");
  }
  if (maxToolCalls < 0 || maxToolCalls > 10) {
    throw new Error("review.max_tool_calls must be between 0 and 10");
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
    throw new Error("review.max_retries must be an integer between 0 and 10");
  }
  if (contextMessages < 0 || contextMessages > 100) {
    throw new Error("review.context_messages must be between 0 and 100");
  }
  return { baseURL, apiKey, model, timeoutMs, maxScriptBytes, maxToolCalls, maxRetries, contextMessages, prompt };
};

const riskToolFromUnknown = (value: unknown): RiskToolConfig => {
  if (!isRecord(value)) return DEFAULT_RISK_TOOL;
  const enabled = booleanField(value, "enabled") ?? DEFAULT_RISK_TOOL.enabled;
  const path = stringField(value, "path") ?? stringField(value, "command");
  const timeoutMs = numberField(value, "timeout_ms") ?? numberField(value, "timeoutMs") ?? DEFAULT_RISK_TOOL.timeoutMs;
  const failOpen = booleanField(value, "fail_open") ?? booleanField(value, "failOpen") ?? DEFAULT_RISK_TOOL.failOpen;
  if (timeoutMs < 500 || timeoutMs > 60_000) {
    throw new Error("tirith.timeout_ms must be between 500 and 60000");
  }
  return { enabled, timeoutMs, failOpen, ...(path ? { path } : {}) };
};

export const policyFromUnknown = (value: unknown, fallbackRules: readonly CommandRule[]): ApprovalPolicy => {
  if (!isRecord(value)) throw new Error("policy must be a JSON object");
  const rawVersion = value["version"];
  if (rawVersion !== undefined && rawVersion !== 1 && rawVersion !== 2) {
    throw new Error("version must be 1 or 2");
  }
  const retireLegacyGenerated = rawVersion === undefined || rawVersion < 2;
  return {
    review: reviewFromUnknown(value["review"]),
    riskTool: riskToolFromUnknown(value["tirith"] ?? value["risk_tool"]),
    rules: mergeRules(rulesFromUnknown(value["rules"], retireLegacyGenerated), fallbackRules),
  };
};
