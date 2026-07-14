import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";
import type { Node } from "web-tree-sitter";

type ParsedTreeVisitor<T> = (root: Node) => T;

let languagePromise: Promise<Language> | undefined;

export const shellParserAssetPaths = (): { readonly core: string; readonly grammar: string } => ({
  core: fileURLToPath(import.meta.resolve("web-tree-sitter/web-tree-sitter.wasm")),
  grammar: fileURLToPath(new URL("../assets/tree-sitter-bash.wasm", import.meta.url)),
});

const loadLanguage = async (): Promise<Language> => {
  const paths = shellParserAssetPaths();
  await Parser.init({ locateFile: () => paths.core });
  return Language.load(paths.grammar);
};

const shellLanguage = (): Promise<Language> => {
  languagePromise ??= loadLanguage();
  return languagePromise;
};

export const withShellTree = async <T>(source: string, visit: ParsedTreeVisitor<T>): Promise<T> => {
  const language = await shellLanguage();
  const parser = new Parser();
  try {
    parser.setLanguage(language);
    const tree = parser.parse(source);
    if (!tree) throw new Error("Tree-sitter returned no syntax tree");
    try {
      return visit(tree.rootNode);
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
};
