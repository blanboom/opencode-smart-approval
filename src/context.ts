import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { allowedReadRoots, canonicalPath, withinPath } from "./path-boundary";
import { isSensitivePathValue } from "./reader-paths";
import type { CommandContext, ScriptEvidence } from "./types";

const SHELLS = new Set(["sh", "bash", "zsh"]);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

export const commandFromArgs = (args: unknown): string | undefined => {
  if (!isRecord(args)) return undefined;
  const command = args["cmd"] ?? args["command"] ?? args["code"];
  return typeof command === "string" && command.length > 0 ? command : undefined;
};

const unescapeQuoted = (value: string): string => {
  return value.replace(/\\(["'\\$` ])/gu, "$1");
};

export const tokenizeShellLike = (command: string): readonly string[] => {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((char === "'" || char === '"') && quote === undefined) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = undefined;
      continue;
    }
    if (quote === undefined && /\s/u.test(char)) {
      if (current.length > 0) tokens.push(unescapeQuoted(current));
      current = "";
      continue;
    }
    if (quote === undefined && /[;&|<>]/u.test(char)) {
      if (current.length > 0) tokens.push(unescapeQuoted(current));
      current = "";
      continue;
    }
    current += char;
  }
  if (current.length > 0) tokens.push(unescapeQuoted(current));
  return tokens;
};

const basename = (path: string): string => {
  return path.split("/").at(-1) ?? path;
};

const looksLikeScriptPath = (token: string): boolean => {
  if (/^https?:\/\//u.test(token)) return false;
  return token.endsWith(".sh") || token.startsWith("/") || token.startsWith("./") || token.startsWith("../") || token.startsWith("~/");
};

const resolvePath = (path: string, cwd: string): string => {
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(cwd, path);
};

export const extractScriptPaths = (command: string, cwd: string): readonly string[] => {
  const tokens = tokenizeShellLike(command);
  const paths = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (SHELLS.has(basename(token))) {
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const candidate = tokens[cursor];
        if (!candidate) break;
        if (candidate === "-c" || candidate === "-s") break;
        if (candidate.startsWith("-")) continue;
        if (looksLikeScriptPath(candidate)) paths.add(resolvePath(candidate, cwd));
        break;
      }
    }
    if (token.endsWith(".sh")) paths.add(resolvePath(token, cwd));
  }
  return [...paths];
};

const readScriptEvidence = (path: string, cwd: string, maxBytes: number): ScriptEvidence => {
  try {
    const canonical = canonicalPath(path);
    if (isSensitivePathValue(path) || isSensitivePathValue(canonical)) {
      return { path, content: "", truncated: false, bytesRead: 0, error: "script path is sensitive and cannot be inspected" };
    }
    if (!allowedReadRoots(cwd).some((root) => withinPath(root, canonical))) {
      return { path, content: "", truncated: false, bytesRead: 0, error: "script path is outside allowed read scope" };
    }
    if (!existsSync(path)) {
      return { path, content: "", truncated: false, bytesRead: 0, error: "file does not exist before command execution" };
    }
    const stat = statSync(path);
    if (!stat.isFile()) {
      return { path, content: "", truncated: false, bytesRead: 0, error: "path is not a regular file" };
    }
    const data = readFileSync(path);
    const slice = data.subarray(0, maxBytes);
    return {
      path,
      content: slice.toString("utf8"),
      truncated: data.byteLength > maxBytes,
      bytesRead: slice.byteLength,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown read failure";
    return { path, content: "", truncated: false, bytesRead: 0, error: message };
  }
};

export const buildCommandContext = (
  input: { readonly tool: string; readonly sessionID: string },
  args: unknown,
  cwd: string,
  maxScriptBytes: number,
): CommandContext | undefined => {
  const command = commandFromArgs(args);
  if (!command) return undefined;
  const scriptEvidence = extractScriptPaths(command, cwd).map((path) => readScriptEvidence(path, cwd, maxScriptBytes));
  return {
    sessionID: input.sessionID,
    tool: input.tool,
    command,
    cwd,
    args,
    scriptEvidence,
  };
};
