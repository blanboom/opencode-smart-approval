import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { countSessionRows } from "../scripts/opencode-e2e/database";

describe("isolated OpenCode database receipts", () => {
  test("counts only rows in the exact harness database", () => {
    // Given an isolated database containing one session row.
    const root = mkdtempSync("/private/tmp/opencode-db-receipt-test-");
    const path = join(root, "opencode.sqlite");
    const database = new Database(path, { create: true, strict: true });
    let closed = false;
    try {
      database.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
      database.query("INSERT INTO session (id) VALUES (?)").run("ses_fixture");
      database.close();
      closed = true;

      // When the read-only harness boundary opens the exact database path.
      const count = countSessionRows(path);

      // Then the exact session row count is returned.
      expect(count).toBe(1);
    } finally {
      if (!closed) database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
