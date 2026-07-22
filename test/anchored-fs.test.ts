import { describe, expect, test } from "bun:test";
import {
  canonicalRootSpelling,
  openAnchoredRegularFile,
  openAnchoredRoot,
  relativePathComponents,
  sameFileSnapshot,
} from "../src/anchored-fs";
import { FakeAnchoredFsAdapter, mustReaderResult } from "./fixtures/fake-anchored-fs";

describe("descriptor anchored filesystem", () => {
  test.each([
    ["length", { size: 9n }],
    ["modification time", { mtimeNs: 11n }],
    ["change time", { ctimeNs: 12n }],
  ] as const)("rejects a regular-file snapshot whose %s changed", (_field, change) => {
    // Given: one regular single-link descriptor snapshot and one changed version field.
    const snapshot = {
      dev: 1n,
      ino: 2n,
      nlink: 1n,
      kind: "regular",
      size: 8n,
      mtimeNs: 10n,
      ctimeNs: 10n,
    } as const;

    // When: descriptor snapshot identity is compared across the change.
    const stable = sameFileSnapshot(snapshot, { ...snapshot, ...change });

    // Then: no content-version or length change is accepted as the same snapshot.
    expect(stable).toBe(false);
  });

  test("parses canonical roots and rejects unsafe traversal components", () => {
    // Given: a canonicalizable absolute root and every forbidden relative component form.
    const invalid = ["", ".", "..", "a/./b", "a/../b", "/absolute", "a//b", "a/", "nul\0name"];

    // When: root and request spellings cross the descriptor boundary.
    const root = canonicalRootSpelling("/private//tmp/./reader/../lease/");
    const findings = invalid.map((value) => relativePathComponents(value));

    // Then: the root is lexical and dot-free, while every unsafe request fails closed.
    expect(root).toEqual({ ok: true, value: { absolute: "/private/tmp/lease", components: ["private", "tmp", "lease"] } });
    expect(findings.every((finding) => !finding.ok && finding.code === "invalid_path")).toBe(true);
  });

  test("holds descriptors on the original namespace across directory replacement", () => {
    // Given: a file below a root whose intermediate directory is replaced after openat returns.
    const adapter = new FakeAnchoredFsAdapter();
    adapter.addFile("/workspace/sub/evidence.txt", "original");
    const slash = mustReaderResult(adapter.openRoot());
    const root = mustReaderResult(openAnchoredRoot(adapter, slash, mustReaderResult(canonicalRootSpelling("/workspace"))));
    adapter.setBarrier((event, namespace) => {
      if (event !== "after_open:sub") return;
      const replacement = namespace.addDirectory("/replacement");
      replacement.entries.set("evidence.txt", namespace.addFile("/escape.txt", "replacement"));
      namespace.replace("/workspace/sub", replacement);
    });

    // When: traversal and positioned read continue through the already-open directory descriptor.
    const file = mustReaderResult(openAnchoredRegularFile(adapter, root, ["sub", "evidence.txt"]));
    const before = mustReaderResult(adapter.stat(file.fd));
    const content = Buffer.from(mustReaderResult(adapter.read(file.fd, 0, 65_536))).toString("utf8");
    const after = mustReaderResult(adapter.stat(file.fd));

    // Then: only the original inode is read and every transient descriptor closes once.
    expect({ content, stable: sameFileSnapshot(before, after), active: adapter.activeDescriptors() }).toEqual({
      content: "original",
      stable: true,
      active: 3,
    });
    expect(adapter.close(file.fd)).toEqual({ ok: true, value: undefined });
    expect(adapter.close(slash)).toEqual({ ok: true, value: undefined });
    expect(adapter.close(root.fd)).toEqual({ ok: true, value: undefined });
  });

  test("anchors the configured root before its namespace entry is replaced", () => {
    // Given: root setup opens a workspace that is replaced immediately after openat returns.
    const adapter = new FakeAnchoredFsAdapter();
    adapter.addFile("/workspace/file.txt", "original");
    const replacement = adapter.addDirectory("/replacement");
    replacement.entries.set("file.txt", adapter.addFile("/elsewhere.txt", "replacement"));
    const slash = mustReaderResult(adapter.openRoot());
    adapter.setBarrier((event) => {
      if (event === "after_open:workspace") adapter.replace("/workspace", replacement);
    });

    // When: root setup completes and a child file is opened relative to its retained descriptor.
    const root = mustReaderResult(openAnchoredRoot(adapter, slash, mustReaderResult(canonicalRootSpelling("/workspace"))));
    const file = mustReaderResult(openAnchoredRegularFile(adapter, root, ["file.txt"]));
    const content = Buffer.from(mustReaderResult(adapter.read(file.fd, 0, 65_536))).toString("utf8");

    // Then: the root descriptor still selects the original directory identity and bytes.
    expect(content).toBe("original");
    expect(adapter.close(file.fd).ok).toBe(true);
    expect(adapter.close(root.fd).ok).toBe(true);
    expect(adapter.close(slash).ok).toBe(true);
  });

  test.each([
    ["intermediate symlink", "/workspace/link/file", "symlink", 1n, "path_unavailable"],
    ["final symlink", "/workspace/link", "symlink", 1n, "path_unavailable"],
    ["special file", "/workspace/device", "other", 1n, "not_regular"],
    ["hardlink", "/workspace/hard", "regular", 2n, "hardlink"],
  ] as const)("rejects %s without leaking a descriptor", (_label, path, kind, nlink, code) => {
    // Given: a root containing one disallowed target shape.
    const adapter = new FakeAnchoredFsAdapter();
    adapter.addDirectory("/workspace");
    if (kind === "symlink") adapter.addSymlink(path.includes("/link/file") ? "/workspace/link" : path);
    else if (kind === "other") adapter.addOther(path);
    else adapter.addFile(path, "blocked", nlink);
    const slash = mustReaderResult(adapter.openRoot());
    const root = mustReaderResult(openAnchoredRoot(adapter, slash, mustReaderResult(canonicalRootSpelling("/workspace"))));
    const components = mustReaderResult(relativePathComponents(path.slice("/workspace/".length)));

    // When: the guarded primitive opens the target.
    const result = openAnchoredRegularFile(adapter, root, components);

    // Then: it fails with a stable code and retains only the borrowed slash and root descriptors.
    expect(result).toEqual({ ok: false, code });
    expect(adapter.activeDescriptors()).toBe(2);
  });

  test("fails closed under descriptor exhaustion and closes acquired intermediates once", () => {
    // Given: capacity for the slash, root, and one intermediate descriptor only.
    const adapter = new FakeAnchoredFsAdapter();
    adapter.addFile("/workspace/sub/file", "content");
    const slash = mustReaderResult(adapter.openRoot());
    const root = mustReaderResult(openAnchoredRoot(adapter, slash, mustReaderResult(canonicalRootSpelling("/workspace"))));
    adapter.setMaxOpen(3);

    // When: final openat exhausts the fake descriptor table.
    const result = openAnchoredRegularFile(adapter, root, ["sub", "file"]);

    // Then: no intermediate remains and the borrowed descriptors stay open.
    expect(result).toEqual({ ok: false, code: "reader_unavailable" });
    expect(adapter.activeDescriptors()).toBe(2);
    expect([...new Set(adapter.events.filter((event) => event.startsWith("close:")))].length).toBe(1);
  });
});
