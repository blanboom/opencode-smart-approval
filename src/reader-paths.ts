import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { CommandArgument, CommandInvocation } from "./command-invocation";
import { commandBasename } from "./command-invocation";
import { canonicalPath, withinPath } from "./path-boundary";
import { searchPathArguments, searchSelectors, searchTraversalPolicy } from "./search-arguments";

export const literalTilde = (argument: CommandArgument): boolean => /^(?:["']|\\)~/u.test(argument.raw);

const activeGlob = (raw: string): boolean => {
  let single = false;
  let double = false;
  let escaped = false;
  for (const char of raw) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && !single) {
      escaped = true;
      continue;
    }
    if (char === "'" && !double) single = !single;
    else if (char === '"' && !single) double = !double;
    else if (!single && !double && /[*?[{]/u.test(char)) return true;
  }
  return false;
};

const staticPrefix = (path: string): string => {
  const wildcard = path.search(/[*?[{]/u);
  if (wildcard < 0) return path;
  const slash = path.lastIndexOf("/", wildcard);
  return slash < 0 ? "." : path.slice(0, slash || 1);
};

const credentialNames = new Set([
  ".env", ".env.local", ".git", ".git-credentials", ".netrc", ".npmrc", ".pypirc", ".ssh",
  ".aws", ".docker", ".kube", ".azure", "auth.json", "command-approval.json", "command-approval.jsonc",
]);
const credentialConfigNames = new Set(["gcloud", "gh", "opencode"]);
const searchCommands = new Set(["egrep", "fgrep", "grep", "rg"]);

export const isSensitivePathValue = (value: string, gitSyntax = false): boolean => {
  const normalized = value.toLowerCase();
  if (/^\/proc\/(?:self|thread-self|\d+)(?:\/task\/(?:self|\d+))?\/environ$/u.test(normalized)) return true;
  const gitPath = normalized.startsWith(":(")
    ? normalized.slice(normalized.indexOf(")") + 1)
    : normalized.replace(/^:[:!^/]?/u, "");
  const path = gitSyntax && gitPath.includes(":") ? gitPath.slice(gitPath.lastIndexOf(":") + 1) : gitPath;
  const components = path.split(/[\/=]/u).filter(Boolean);
  if (components.some((component) => credentialNames.has(component) || component.startsWith(".env."))) return true;
  return components.some((component, index) =>
    component === ".config" && credentialConfigNames.has(components[index + 1] ?? "")
  );
};

const explicitHiddenPattern = (pattern: string): boolean =>
  pattern.startsWith(".") || pattern.startsWith("[.]") || pattern.includes("/.") || pattern.includes("/[.]") ||
  /(?:^|[{,])\./u.test(pattern);

const componentMatches = (pattern: string, candidates: readonly string[], includeHidden = false): boolean => {
  const folded = pattern.toLowerCase();
  if (folded === "*" || folded === "**") return false;
  try {
    const glob = new Bun.Glob(folded);
    return candidates.some((candidate) =>
      (includeHidden || !candidate.startsWith(".") || explicitHiddenPattern(folded)) && glob.match(candidate)
    );
  } catch (error) {
    if (error instanceof Error) return true;
    throw error;
  }
};

export const mayMatchSensitivePath = (argument: CommandArgument, commandPattern = false): boolean => {
  if (!(commandPattern ? /[*?[{]/u.test(argument.value) : activeGlob(argument.raw))) return false;
  const components = argument.value.split("/").filter(Boolean);
  if (components.some((component) => componentMatches(component, [...credentialNames], commandPattern))) return true;
  for (let index = 0; index < components.length - 1; index += 1) {
    if (
      componentMatches(components[index] ?? "", [".config"], commandPattern) &&
      componentMatches(components[index + 1] ?? "", [...credentialConfigNames], commandPattern)
    ) return true;
  }
  return false;
};

export const expandedPath = (argument: CommandArgument, cwd: string): string | undefined => {
  const base = argument.resolutionBase ? resolve(cwd, argument.resolutionBase) : cwd;
  if (literalTilde(argument)) return resolve(base, staticPrefix(argument.value));
  if (argument.value === "~" || argument.value.startsWith("~/")) {
    return resolve(homedir(), staticPrefix(argument.value.slice(2)));
  }
  if (argument.value === "~+" || argument.value.startsWith("~+/")) {
    return resolve(base, staticPrefix(argument.value.slice(3)));
  }
  if (argument.value.startsWith("~")) return undefined;
  return resolve(base, staticPrefix(argument.value));
};

export type GlobFinding = "escape" | "limit" | "sensitive";

export const globFinding = (
  argument: CommandArgument,
  cwd: string,
  roots: readonly string[],
): GlobFinding | undefined => {
  if (!activeGlob(argument.raw)) return undefined;
  const prefix = expandedPath(argument, cwd);
  if (!prefix) return "limit";
  if (!existsSync(prefix)) return undefined;
  const base = argument.resolutionBase ? resolve(cwd, argument.resolutionBase) : cwd;
  const expandedPattern = argument.value.startsWith("~/")
    ? resolve(homedir(), argument.value.slice(2))
    : argument.value.startsWith("~+/")
      ? resolve(base, argument.value.slice(3))
      : isAbsolute(argument.value)
        ? argument.value
        : argument.resolutionBase
          ? resolve(base, argument.value)
          : argument.value;
  const absolutePattern = isAbsolute(expandedPattern);
  const pattern = expandedPattern.toLowerCase().split("\\").join("/");
  const patternComponents = pattern.split("/").filter(Boolean);
  const maxDepth = pattern.includes("**") ? 64 : Math.max(1, patternComponents.length - (absolutePattern ? prefix.split("/").filter(Boolean).length : relative(cwd, prefix).split("/").filter(Boolean).length));
  const stack = [{ directory: prefix, depth: 0 }];
  let visited = 0;
  try {
    const glob = new Bun.Glob(pattern);
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) break;
      for (const entry of readdirSync(current.directory, { withFileTypes: true })) {
        const path = join(current.directory, entry.name);
        const candidate = (absolutePattern ? path : relative(cwd, path)).split("\\").join("/");
        const candidateComponents = candidate.toLowerCase().split("/").filter(Boolean);
        const hidden = candidateComponents.some((component) => component.startsWith("."));
        const matches = glob.match(candidate.toLowerCase()) && (!hidden || explicitHiddenPattern(pattern));
        const mayDescend = current.depth + 1 < maxDepth;
        if (!matches && !mayDescend) continue;
        visited += 1;
        if (visited > 512) return "limit";
        if (matches) {
          const target = canonicalPath(path);
          if (!roots.some((root) => withinPath(root, target))) return "escape";
          if (isSensitivePathValue(target)) return "sensitive";
        }
        if (mayDescend) {
          const relativeDepth = candidateComponents.length;
          const prefixMayMatch = patternComponents.slice(0, relativeDepth).every((component, index) => {
            if (component === "**") return true;
            const candidateComponent = candidateComponents[index] ?? "";
            return componentMatches(component, [candidateComponent]);
          });
          if (!prefixMayMatch) continue;
          const target = canonicalPath(path);
          let directory = entry.isDirectory();
          if (!directory && target !== path) {
            try {
              directory = statSync(target).isDirectory();
            } catch (error) {
              if (error instanceof Error) return "limit";
              throw error;
            }
          }
          if (directory) {
            if (!roots.some((root) => withinPath(root, target))) return "escape";
            stack.push({ directory: path, depth: current.depth + 1 });
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof Error) return "limit";
    throw error;
  }
  return undefined;
};

type SearchTraversalFinding = "limit" | "sensitive";

const directorySearchFinding = (directory: string, includeHidden: boolean): SearchTraversalFinding | undefined => {
  const stack = [directory];
  let visited = 0;
  try {
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) break;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (!includeHidden && entry.name.startsWith(".")) continue;
        visited += 1;
        if (visited > 4096) return "limit";
        const path = join(current, entry.name);
        const target = canonicalPath(path);
        if (isSensitivePathValue(path) || isSensitivePathValue(target)) return "sensitive";
        if (entry.isDirectory()) stack.push(path);
      }
    }
  } catch (error) {
    if (error instanceof Error) return "limit";
    throw error;
  }
  return undefined;
};

export const searchTraversalFinding = (
  invocation: CommandInvocation,
  cwd: string,
): SearchTraversalFinding | undefined => {
  if (!searchCommands.has(commandBasename(invocation))) return undefined;
  const selectors = searchSelectors(invocation).filter((selector) => !selector.value.startsWith("!"));
  const selectorSensitive = selectors.some((selector) =>
    isSensitivePathValue(selector.value) || mayMatchSensitivePath(selector, true)
  );
  const traversal = searchTraversalPolicy(invocation);
  if (!selectorSensitive && !traversal.recursive && !traversal.hidden) return undefined;
  const paths = searchPathArguments(invocation);
  const roots = paths.length > 0 ? paths : [{ raw: ".", value: "." }];
  for (const argument of roots) {
    const expanded = expandedPath(argument, cwd);
    if (!expanded) return "limit";
    try {
      if (!existsSync(expanded) || !statSync(expanded).isDirectory()) continue;
    } catch (error) {
      if (error instanceof Error) return "limit";
      throw error;
    }
    if (selectorSensitive) return "sensitive";
    const finding = directorySearchFinding(expanded, traversal.hidden);
    if (finding) return finding;
  }
  return undefined;
};

export const searchMayReadSensitiveFiles = (invocation: CommandInvocation, cwd: string): boolean => {
  return searchTraversalFinding(invocation, cwd) === "sensitive";
};
