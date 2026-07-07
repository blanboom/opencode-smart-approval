import type { PluginInput } from "@opencode-ai/plugin";

type SessionClient = PluginInput["client"];

const MAX_TEXT_CHARS = 2000;
const MAX_TRANSCRIPT_CHARS = 20000;

const truncate = (text: string, max: number): string => {
  return text.length > max ? text.slice(0, max) + "..." : text;
};

const extractTextFromParts = (parts: unknown[]): string => {
  const texts: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p["type"] === "text" && typeof p["text"] === "string") {
      texts.push(truncate(p["text"] as string, MAX_TEXT_CHARS));
    } else if (p["type"] === "tool") {
      const tool = p["tool"] as string | undefined;
      const state = p["state"] as string | undefined;
      texts.push(`[tool: ${tool ?? "unknown"} (${state ?? "unknown"})]`);
    }
  }
  return texts.join("\n");
};

export const fetchSessionContext = async (
  client: SessionClient | undefined,
  sessionID: string,
  maxMessages: number,
): Promise<string> => {
  if (!client || maxMessages <= 0) return "";

  try {
    const response = await client.session.messages({
      path: { id: sessionID },
      query: { limit: maxMessages },
    });

    if (!response.data || !Array.isArray(response.data)) return "";

    const entries: string[] = [];
    for (const entry of response.data) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const info = e["info"] as Record<string, unknown> | undefined;
      const parts = e["parts"];
      if (!info || !Array.isArray(parts)) continue;

      const role = info["role"] as string | undefined;
      const text = extractTextFromParts(parts as unknown[]);
      if (text.length === 0) continue;

      entries.push(`[${role ?? "unknown"}] ${text}`);
    }

    const transcript = entries.join("\n---\n");
    return truncate(transcript, MAX_TRANSCRIPT_CHARS);
  } catch {
    return "";
  }
};