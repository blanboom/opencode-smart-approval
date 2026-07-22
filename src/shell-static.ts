import type { Node } from "web-tree-sitter";
import type { ShellAssignment, ShellIssue, ShellRedirection } from "./types";

const safeNamedTypes = new Set([
  "program", "list", "pipeline", "command", "command_name", "word", "number", "raw_string", "string",
  "string_content", "concatenation", "comment", "subshell", "compound_statement", "negated_command",
  "variable_assignment", "variable_name", "redirected_statement", "file_redirect", "file_descriptor",
]);

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

type StaticCommandNodes = {
  readonly name?: Node;
  readonly arguments: readonly Node[];
  readonly assignments: readonly ShellAssignment[];
};

const commandRedirectNodes = (node: Node): readonly Node[] => {
  const direct = node.namedChildren.filter((child) => child.type === "file_redirect");
  const parent = node.parent;
  const body = parent?.childForFieldName("body");
  if (parent?.type !== "redirected_statement" || body?.startIndex !== node.startIndex || body.endIndex !== node.endIndex) {
    return direct;
  }
  return [...direct, ...parent.namedChildren.filter((child) => child.type === "file_redirect")];
};

const numericDescriptorBefore = (node: Node, redirectStarts: ReadonlySet<number>): boolean => {
  const number = node.type === "number" ? node : node.type === "command_name" ? node.namedChildren[0] : undefined;
  return number?.type === "number" && number.startIndex === node.startIndex
    && number.endIndex === node.endIndex && redirectStarts.has(node.endIndex);
};

const recoveredCommandWords = (node: Node): readonly Node[] => {
  const redirects = commandRedirectNodes(node);
  const redirectStarts = new Set(redirects.map((redirect) => redirect.startIndex));
  return [
    node.childForFieldName("name"),
    ...node.childrenForFieldName("argument"),
    ...redirects.flatMap((redirect) => redirect.childrenForFieldName("destination").slice(1)),
  ].filter((word): word is Node => word !== null && !numericDescriptorBefore(word, redirectStarts))
    .sort((left, right) => left.startIndex - right.startIndex);
};

const shellAssignment = (source: string, node: Node): ShellAssignment | undefined => {
  if (node.type === "variable_assignment") {
    const [name, value] = node.namedChildren;
    return name ? { name: staticWord(source, name), value: value ? staticWord(source, value) : "", raw: sourceSlice(source, node) } : undefined;
  }
  const raw = sourceSlice(source, node);
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)/u.exec(raw);
  const name = match?.[1];
  return name ? { name, value: staticWord(source, node).slice(name.length + (match?.[2]?.length ?? 0)), raw } : undefined;
};

export const staticCommandNodes = (node: Node, source: string): StaticCommandNodes => {
  const words = recoveredCommandWords(node);
  const assignments = node.namedChildren
    .filter((child) => child.type === "variable_assignment")
    .flatMap((assignment) => shellAssignment(source, assignment) ?? []);
  let firstCommandWord = 0;
  for (const word of words) {
    const assignment = shellAssignment(source, word);
    if (!assignment) break;
    assignments.push(assignment);
    firstCommandWord += 1;
  }
  const commandWords = words.slice(firstCommandWord);
  return { ...(commandWords[0] ? { name: commandWords[0] } : {}), arguments: commandWords.slice(1), assignments };
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
  const target = node.childForFieldName("destination");
  if (!target || hasDynamicDescendant(target)) return undefined;
  if (![">", ">>", "<", ">&", "<&", "&>", "&>>"].includes(operator)) return undefined;
  return {
    operator,
    target: { raw: sourceSlice(source, target), value: staticWord(source, target) },
  };
};

export const safeFileRedirect = (node: Node, source: string): boolean =>
  staticFileRedirect(node, source) !== undefined;

export const structuralShellIssue = (node: Node, source: string): ShellIssue | undefined => {
  if (node.isError || node.isMissing) return { kind: "syntax", reason: "shell syntax contains an error or missing token" };
  if (node.isNamed && !safeNamedTypes.has(node.type)) {
    const dynamic = ["expansion", "simple_expansion", "command_substitution", "process_substitution", "arithmetic_expansion"];
    return {
      kind: dynamic.includes(node.type) ? "dynamic" : "unsupported",
      reason: `shell syntax '${node.type}' requires review`,
    };
  }
  if (!node.isNamed && node.type === "&") return { kind: "unsupported", reason: "background execution requires review" };
  if (node.type === "file_redirect" && !safeFileRedirect(node, source)) {
    const operator = node.children.find((child) => !child.isNamed)?.type ?? "";
    return {
      kind: "unsupported",
      reason: "file redirection requires review",
      redirectionDirection: operator.startsWith("<") && operator !== "<>" ? "input" : "output",
    };
  }
  if (node.type === "variable_assignment" && node.parent?.type !== "command") {
    return { kind: "unsupported", reason: "standalone variable assignment changes later shell state" };
  }
  return undefined;
};

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
