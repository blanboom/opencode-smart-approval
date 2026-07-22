import { expect, test } from "bun:test";
import {
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { AnchoredFsAdapter } from "../src/anchored-fs";
import { createPosixAnchoredFsAdapter } from "../src/anchored-fs-posix";
import { APPROVAL_AGENT_NAME } from "../src/approval-agent";
import { createApprovalReader, type ApprovalReader } from "../src/approval-reader";
import { mustReaderResult } from "./fixtures/fake-anchored-fs";

const POSIX_PLATFORM = process.platform === "darwin" || process.platform === "linux";

test.skipIf(!POSIX_PLATFORM)("rejects an equal-length in-place overwrite between descriptor validation and read", () => {
  // Given: a real POSIX workspace file and a deterministic mutation at the positioned-read boundary.
  const tempRoot = process.platform === "darwin" ? "/private/tmp" : "/tmp";
  const directory = mkdtempSync(join(tempRoot, "approval-reader-version-"));
  const path = join(directory, "evidence.txt");
  const originalTime = new Date("2020-01-01T00:00:00.000Z");
  const replacementTime = new Date("2021-01-01T00:00:00.000Z");
  const replacement = Buffer.from("changed!");
  writeFileSync(path, "original");
  utimesSync(path, originalTime, originalTime);
  const native = createPosixAnchoredFsAdapter();
  let mutated = false;
  const adapter: AnchoredFsAdapter = {
    available: native.available,
    openRoot: () => native.openRoot(),
    openAt: (request) => native.openAt(request),
    stat: (fd) => native.stat(fd),
    read: (fd, offset, length) => {
      if (!mutated) {
        const writer = openSync(path, "r+");
        try {
          const written = writeSync(writer, replacement, 0, replacement.byteLength, 0);
          if (written !== replacement.byteLength) throw new TypeError("short test-fixture write");
          fsyncSync(writer);
        } finally {
          closeSync(writer);
        }
        utimesSync(path, replacementTime, replacementTime);
        mutated = true;
      }
      return native.read(fd, offset, length);
    },
    close: (fd) => native.close(fd),
    dispose: () => native.dispose(),
  };
  let reader: ApprovalReader | undefined;

  try {
    reader = mustReaderResult(createApprovalReader({ adapter, workspaceRoot: directory, tempRoots: [] }));
    mustReaderResult(reader.activate({
      sessionID: "child-1",
      agent: APPROVAL_AGENT_NAME,
      directory,
      references: [],
    }));

    // When: the approval reader crosses the real in-place overwrite boundary.
    const result = reader.read({ path: "evidence.txt" }, {
      sessionID: "child-1",
      agent: APPROVAL_AGENT_NAME,
      directory,
      abort: new AbortController().signal,
    });

    // Then: no bytes from the changed version escape even though inode, link count, and length stayed equal.
    expect({ result, mutated, disk: readFileSync(path, "utf8") }).toEqual({
      result: '{"ok":false,"error":"revoked"}',
      mutated: true,
      disk: "changed!",
    });
  } finally {
    reader?.dispose();
    native.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
