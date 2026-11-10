import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openReadOnlyDatabase } from "../src/adapters/util";

test("database adapters can read agent data but cannot modify it", () => {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "tracevault-sqlite-"));
  const path = join(dir, "agent.db");
  try {
    const writer = new DatabaseSync(path);
    writer.exec("CREATE TABLE messages (text TEXT); INSERT INTO messages VALUES ('hello')");
    writer.close();
    const reader = openReadOnlyDatabase(path);
    try {
      expect(reader.prepare("SELECT text FROM messages").get()).toEqual({ text: "hello" });
      expect(() => reader.exec("DELETE FROM messages")).toThrow();
    } finally { reader.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
