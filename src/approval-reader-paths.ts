import { isAbsolute } from "node:path/posix";
import {
  canonicalRootSpelling,
  readerError,
  readerOk,
  relativePathComponents,
  type CanonicalRoot,
  type ReaderResult,
} from "./anchored-fs";
import { isSensitivePathValue } from "./reader-paths";
import type { StaticFileReference } from "./types";

export type AuthorizedAnchoredPath = {
  readonly absolute: string;
  readonly relative: string;
  readonly components: readonly string[];
};

const joinedAbsolute = (root: CanonicalRoot, components: readonly string[]): string =>
  root.absolute === "/" ? `/${components.join("/")}` : `${root.absolute}/${components.join("/")}`;

const absoluteRemainder = (root: CanonicalRoot, request: string): ReaderResult<string> => {
  if (root.absolute === "/") return readerOk(request.slice(1));
  const prefix = `${root.absolute}/`;
  return request.startsWith(prefix) ? readerOk(request.slice(prefix.length)) : readerError("unauthorized");
};

export const authorizeAnchoredPath = (
  root: CanonicalRoot,
  request: string,
): ReaderResult<AuthorizedAnchoredPath> => {
  if (request.length === 0) return readerError("invalid_path");
  const remainder = isAbsolute(request) ? absoluteRemainder(root, request) : readerOk(request);
  if (!remainder.ok) return remainder;
  const parsed = relativePathComponents(remainder.value);
  if (!parsed.ok) return parsed;
  const relative = parsed.value.join("/");
  const absolute = joinedAbsolute(root, parsed.value);
  if (
    isSensitivePathValue(request, false)
    || isSensitivePathValue(relative, false)
    || isSensitivePathValue(absolute, false)
  ) return readerError("sensitive_path");
  return readerOk(Object.freeze({ absolute, relative, components: parsed.value }));
};

export const absoluteStaticReference = (reference: StaticFileReference): ReaderResult<string> => {
  if (isAbsolute(reference.value)) {
    const parsed = relativePathComponents(reference.value.slice(1));
    return parsed.ok ? readerOk(`/${parsed.value.join("/")}`) : parsed;
  }
  const cwd = canonicalRootSpelling(reference.cwd);
  if (!cwd.ok) return cwd;
  const relative = reference.value.startsWith("./") ? reference.value.slice(2) : reference.value;
  const parsed = relativePathComponents(relative);
  if (!parsed.ok) return parsed;
  return readerOk(joinedAbsolute(cwd.value, parsed.value));
};
