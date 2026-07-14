import type { Node } from "web-tree-sitter";
import type { ShellIssue, ShellRedirection } from "./types";

export const sourceSlice = (source: string, node: Node): string =>
  source.slice(node.startIndex, node.endIndex);

export const byteOffsetsFor = (source: string): Uint32Array => {
  const offsets = new Uint32Array(source.length + 1);
  let byteOffset = 0;
  for (let index = 0; index < source.length; index += 1) {
    offsets[index] = byteOffset;
    const codePoint = source.codePointAt(index);
    if (codePoint === undefined) continue;
    const width = codePoint > 0xffff ? 2 : 1;
    byteOffset += Buffer.byteLength(String.fromCodePoint(codePoint), "utf8");
    if (width === 2) {
      index += 1;
      offsets[index] = byteOffset;
    }
  }
  offsets[source.length] = byteOffset;
  return offsets;
};

export const controlCharacterIssue = (source: string): ShellIssue | undefined => {
  for (const char of source) {
    const code = char.codePointAt(0);
    if (code !== undefined && code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return { kind: "syntax", reason: "shell command contains a disallowed control character" };
    }
  }
  return undefined;
};

export const hasDynamicDescendant = (node: Node): boolean => {
  if (["expansion", "simple_expansion", "command_substitution", "process_substitution"].includes(node.type)) {
    return true;
  }
  return node.children.some(hasDynamicDescendant);
};

export const staticWord = (source: string, node: Node): string => {
  const value = sourceSlice(source, node);
  if (node.type === "raw_string") return value.slice(1, -1);
  if (node.type === "string") {
    return value.slice(1, -1).replace(/\\([\\$`"\n])/gu, (_match, escaped: string) =>
      escaped === "\n" ? "" : escaped,
    );
  }
  if (node.type === "command_name" || node.type === "concatenation") {
    return node.namedChildren.map((child) => staticWord(source, child)).join("");
  }
  return value.replace(/\\\n/gu, "").replace(/\\(.)/gu, "$1");
};

export const staticFileRedirect = (node: Node, source: string): ShellRedirection | undefined => {
  const operator = node.children.find((child) => !child.isNamed)?.type ?? "";
  const target = node.namedChildren.at(-1);
  if (!target || hasDynamicDescendant(target)) return undefined;
  if (![">", ">>", "<", ">&", "<&", "&>", "&>>"].includes(operator)) return undefined;
  return {
    operator,
    target: { raw: sourceSlice(source, target), value: staticWord(source, target) },
  };
};

export const safeFileRedirect = (node: Node, source: string): boolean =>
  staticFileRedirect(node, source) !== undefined;

export const enclosingRedirections = (node: Node, source: string): readonly ShellRedirection[] => {
  const redirections: ShellRedirection[] = [];
  for (let ancestor: Node | null = node; ancestor; ancestor = ancestor.parent) {
    for (const child of ancestor.namedChildren) {
      if (child.type !== "file_redirect") continue;
      const parsed = staticFileRedirect(child, source);
      if (parsed) redirections.push(parsed);
    }
  }
  return redirections;
};

export const shellScriptIndex = (args: readonly string[]): number | undefined => {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument || argument === "--" || !argument.startsWith("-")) return undefined;
    if (argument === "-O" || argument === "-o" || argument === "--rcfile" || argument === "--init-file") {
      index += 1;
      continue;
    }
    if (/^-[^-]*c/u.test(argument)) return index + 1;
  }
  return undefined;
};
