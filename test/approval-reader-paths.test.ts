import { describe, expect, test } from "bun:test";
import { canonicalRootSpelling } from "../src/anchored-fs";
import { absoluteStaticReference, authorizeAnchoredPath } from "../src/approval-reader-paths";
import type { StaticFileReference } from "../src/types";
import { mustReaderResult } from "./fixtures/fake-anchored-fs";

const root = (absolute: string) => mustReaderResult(canonicalRootSpelling(absolute));

describe("approval reader path authorization", () => {
  test("normalizes one trusted Todo1 leading-dot reference without loosening tool paths", () => {
    // Given: an extractor-owned relative reference and an identical untrusted tool spelling.
    const reference: StaticFileReference = {
      kind: "shell_script", raw: "./script.sh", value: "./script.sh", topLevelSegment: 0, cwd: "/tmp",
    };

    // When: trusted reference mapping and ordinary tool authorization run independently.
    const mapped = absoluteStaticReference(reference);
    const toolPath = authorizeAnchoredPath(root("/tmp"), "./script.sh");

    // Then: only the trusted reference drops its single conventional leading dot component.
    expect(mapped).toEqual({ ok: true, value: "/tmp/script.sh" });
    expect(toolPath).toEqual({ ok: false, code: "invalid_path" });
  });

  test.each([
    "./", "././file", "./dir/./file", "./dir/../file", "../file", "dir/../file",
    "dir//file", "dir/", "file\0name", "//tmp/file", "/tmp/../file",
  ])("keeps unsafe trusted-reference spelling fail-closed: %s", (value) => {
    // Given: a Todo1-shaped record containing grammar outside its trusted lexical guarantees.
    const reference: StaticFileReference = { kind: "source", raw: value, value, topLevelSegment: 0, cwd: "/tmp" };

    // When: the trusted-reference-only normalizer maps it beneath cwd.
    const result = absoluteStaticReference(reference);

    // Then: leading normalization never admits separators, interior dots, traversal, NUL, or absolute remainder tricks.
    expect(result).toEqual({ ok: false, code: "invalid_path" });
  });

  test.each([
    ".env", ".env.local", ".env.production", ".git/config", ".git-credentials", ".netrc", ".npmrc",
    ".pypirc", ".ssh/id", ".aws/credentials", ".docker/config", ".kube/config", ".azure/auth", "auth.json",
    ".CONFIG/GH/hosts.yml", ".config/gcloud/credentials.db", "key=.npmrc",
    "/proc/self/environ", "/proc/thread-self/environ", "/proc/123/environ", "/proc/123/task/self/environ",
    "/proc/123/task/456/environ",
  ])("rejects sensitive spelling %s with the sole POSIX predicate", (path) => {
    // Given: the complete credential, config, equals-split, case-folded, and proc-environ matrix.
    const base = path.startsWith("/") ? root("/") : root("/workspace");

    // When: all three lexical spellings are checked before traversal.
    const result = authorizeAnchoredPath(base, path);

    // Then: the path fails closed without components.
    expect(result).toEqual({ ok: false, code: "sensitive_path" });
  });

  test.each([
    ["/proc/123", "environ"],
    ["/proc/123/task/456", "environ"],
    ["/home/user/.config/gh", "hosts.yml"],
    ["/home/user/.ssh", "id_ed25519"],
  ])("rejects request %s/%s when only the absolute root-plus-components spelling is sensitive", (absolute, path) => {
    // Given: an apparently ordinary relative request under a sensitive configured root.
    // When: the request is authorized against that root spelling.
    const result = authorizeAnchoredPath(root(absolute), path);

    // Then: root-relative camouflage cannot bypass the predicate.
    expect(result).toEqual({ ok: false, code: "sensitive_path" });
  });

  test("keeps backslash literal, accepts near misses, and rejects outside absolute paths", () => {
    // Given: POSIX-literal backslashes, adjacent names, one safe absolute path, and one escape.
    const base = root("/workspace");
    const requests = ["dir\\.ssh\\key", ".environment", "config/ghx/file", "/workspace/safe.txt"];

    // When: each request is reduced to anchored components.
    const safe = requests.map((path) => authorizeAnchoredPath(base, path));
    const outside = authorizeAnchoredPath(base, "/outside/file");

    // Then: safe POSIX spellings remain readable and the absolute escape is unauthorized.
    expect(safe.every((result) => result.ok)).toBe(true);
    expect(outside).toEqual({ ok: false, code: "unauthorized" });
  });
});
