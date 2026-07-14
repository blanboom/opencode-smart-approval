import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export const canonicalPath = (path: string): string => {
  let cursor = resolve(path);
  const suffix: string[] = [];
  try {
    while (!existsSync(cursor)) {
      const parent = dirname(cursor);
      if (parent === cursor) break;
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
    return resolve(realpathSync(cursor), ...suffix);
  } catch (error) {
    if (error instanceof Error) return resolve(path);
    throw error;
  }
};

export const withinPath = (root: string, target: string): boolean => {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const uniqueCanonical = (paths: readonly string[]): readonly string[] =>
  [...new Set(paths.map(canonicalPath))];

export const temporaryRoots = (): readonly string[] =>
  uniqueCanonical([tmpdir(), "/tmp", "/private/tmp"]);

export const allowedReadRoots = (cwd: string): readonly string[] =>
  uniqueCanonical([cwd, ...temporaryRoots()]);

export const pathWithinRoots = (path: string, roots: readonly string[]): boolean => {
  const target = canonicalPath(path);
  return roots.some((root) => withinPath(root, target));
};
