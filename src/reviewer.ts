import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, isStepCount, zodSchema } from "ai";
import { z } from "zod";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import type { CommandContext, ResolvedPolicy, ReviewResponse, RuleEvaluation } from "./types";
import { buildReviewPrompt } from "./prompt";
import { allowedReadRoots, canonicalPath, withinPath } from "./path-boundary";
import { isSensitivePathValue } from "./reader-paths";

const REVIEW_OUTPUT_SCHEMA = z.object({
  outcome: z.enum(["allow", "deny"]),
  risk_level: z.enum(["low", "medium", "high", "critical"]),
  user_authorization: z.enum(["unknown", "low", "medium", "high"]),
  categories: z.array(
    z.object({
      id: z.string().min(1),
      score: z.coerce.number().min(0).max(1),
    }),
  ),
  reasons: z.array(z.string().min(1)),
});

export const failClosedReview = (reason: string): ReviewResponse => {
  return {
    outcome: "deny",
    riskLevel: "high",
    userAuthorization: "unknown",
    categories: [{ id: "security.reviewer_unavailable", score: 1 }],
    reasons: [reason],
  };
};

export const reviewResponseFromOutput = (output: unknown): ReviewResponse => {
  const parsed = REVIEW_OUTPUT_SCHEMA.parse(output);
  return {
    outcome: parsed.outcome,
    riskLevel: parsed.risk_level,
    userAuthorization: parsed.user_authorization,
    categories: parsed.categories,
    reasons: parsed.reasons,
  };
};

// Extract JSON from a text response that may be wrapped in markdown code fences.
const extractJsonFromText = (text: string): string => {
  // Try direct parse first
  const trimmed = text.trim();
  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch && fenceMatch[1]) return fenceMatch[1].trim();
  // Find first { and last } as a fallback
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
};

const isPathAllowed = (path: string, cwd: string): boolean => {
  const resolved = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const canonical = canonicalPath(resolved);
  return !isSensitivePathValue(resolved) && !isSensitivePathValue(canonical) &&
    allowedReadRoots(cwd).some((root) => withinPath(root, canonical));
};

export const safeReadFile = (path: string, cwd: string, maxBytes: number = 10000): string => {
  const resolved = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  if (!isPathAllowed(resolved, cwd)) return `Error: path ${path} is outside allowed read scope`;
  try {
    if (!existsSync(resolved)) return `Error: file not found: ${path}`;
    const stat = statSync(resolved);
    if (!stat.isFile()) return `Error: not a regular file: ${path}`;
    const data = readFileSync(resolved);
    const slice = data.subarray(0, maxBytes);
    return slice.toString("utf8") + (data.byteLength > maxBytes ? "\n... (truncated)" : "");
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : "read failed"}`;
  }
};

export const safeListFiles = (path: string, cwd: string): string => {
  const resolved = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  if (!isPathAllowed(resolved, cwd)) return `Error: path ${path} is outside allowed read scope`;
  try {
    if (!existsSync(resolved)) return `Error: directory not found: ${path}`;
    const stat = statSync(resolved);
    if (!stat.isDirectory()) return `Error: not a directory: ${path}`;
    const entries = readdirSync(resolved, { withFileTypes: true });
    return entries
      .map((e) => `${e.isDirectory() ? "dir" : "file"} ${relative(resolve(cwd), resolve(resolved, e.name)) || e.name}`)
      .join("\n");
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : "list failed"}`;
  }
};

export const reviewWithAiSdk = async (
  policy: ResolvedPolicy,
  context: CommandContext,
  evaluation: RuleEvaluation,
  transcript: string,
): Promise<ReviewResponse> => {
  try {
    const provider = createOpenAICompatible({
      name: "opencode-smart-approval",
      baseURL: policy.review.baseURL,
      apiKey: policy.review.apiKey,
      supportsStructuredOutputs: false,
    });

    const readOnlyTools = {
      read_file: {
        description: "Read a file within the project directory or tmp. Use for verifying file existence and content before approving/denying destructive actions.",
        inputSchema: zodSchema(z.object({ path: z.string().describe("File path relative to cwd or absolute") })),
        execute: async ({ path }: { path: string }) => safeReadFile(path, context.cwd),
      },
      list_files: {
        description: "List files in a directory within the project directory or tmp. Use for checking directory contents and structure.",
        inputSchema: zodSchema(z.object({ path: z.string().describe("Directory path relative to cwd or absolute, defaults to cwd") })),
        execute: async ({ path }: { path: string }) => safeListFiles(path || ".", context.cwd),
      },
    } as const;

    const prompt = buildReviewPrompt(context, evaluation, transcript, policy.review.prompt);
    const formatAttempts = policy.review.maxRetries === 0 ? 1 : 2;
    let parseFailure: Error | undefined;
    for (let attempt = 0; attempt < formatAttempts; attempt += 1) {
      const result = await generateText({
        model: provider.chatModel(policy.review.model),
        prompt: attempt === 0
          ? prompt
          : `${prompt}\n\nThe prior response was invalid. Return one complete JSON object matching the schema.`,
        tools: readOnlyTools,
        stopWhen: isStepCount(policy.review.maxToolCalls > 0 ? policy.review.maxToolCalls + 1 : 1),
        temperature: 0,
        maxOutputTokens: 1000,
        maxRetries: policy.review.maxRetries,
        abortSignal: AbortSignal.timeout(policy.review.timeoutMs),
      });

      try {
        // Parse JSON manually because compatible endpoints may wrap JSON in markdown fences.
        const jsonText = extractJsonFromText(result.text);
        return reviewResponseFromOutput(JSON.parse(jsonText));
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof z.ZodError)) throw error;
        parseFailure = error;
      }
    }
    return failClosedReview(`reviewer failed: ${parseFailure?.message ?? "invalid structured output"}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown reviewer failure";
    return failClosedReview(`reviewer failed: ${message}`);
  }
};
