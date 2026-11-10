/**
 * Cursor adapter (raw tier only for now).
 *
 * Cursor stores chats in VS Code-style SQLite key-value databases (`state.vscdb`).
 * The global database also holds login tokens, so instead of archiving the files
 * this adapter extracts only chat-related keys: agent/composer conversations
 * (`composerData:*`, `bubbleId:*`), checkpoints and code diffs from the global
 * store, plus the per-workspace prompt history.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openReadOnlyDatabase } from "./util";
import type { Adapter, SourceItem } from "../types";

const USER_DIR = ["Library", "Application Support", "Cursor", "User"];

/** Key prefixes in the global `cursorDiskKV` table that hold conversation data. */
const GLOBAL_PREFIXES = ["composerData:", "bubbleId:", "checkpointId:", "codeBlockDiff:", "messageRequestContext:"];
/** Keys in a workspace's `ItemTable` that hold prompt and chat history. */
const WORKSPACE_KEYS = ["aiService.prompts", "aiService.generations", "composer.composerData", "workbench.panel.aichat.view.aichat.chatdata"];


/** Reads the allow-listed chat rows from one database as a JSON object. */
function extractChatRows(dbPath: string, global: boolean): Record<string, string> {
  const db = openReadOnlyDatabase(dbPath);
  const out: Record<string, string> = {};
  try {
    if (global) {
      for (const prefix of GLOBAL_PREFIXES) {
        const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ?").all(`${prefix}%`) as { key: string; value: unknown }[];
        for (const r of rows) out[r.key] = String(r.value ?? "");
      }
    } else {
      const rows = db
        .prepare(`SELECT key, value FROM ItemTable WHERE key IN (${WORKSPACE_KEYS.map(() => "?").join(",")})`)
        .all(...WORKSPACE_KEYS) as { key: string; value: unknown }[];
      for (const r of rows) out[r.key] = String(r.value ?? "");
    }
  } catch {
    /* table missing in older Cursor versions: nothing to extract */
  } finally {
    db.close();
  }
  return out;
}

export const cursor: Adapter = {
  id: "cursor",
  label: "Cursor",
  async discover(home) {
    const userDir = join(home, ...USER_DIR);
    const items: SourceItem[] = [];
    const add = (key: string, path: string, global: boolean) => {
      const rows = extractChatRows(path, global);
      const size = Object.values(rows).reduce((n, v) => n + v.length, 0);
      // mtime is not meaningful for an extract; size changes whenever chats change.
      if (size > 0) items.push({ agent: "cursor", key, path, size, mtimeMs: 0 });
    };
    const globalDb = join(userDir, "globalStorage", "state.vscdb");
    if (existsSync(globalDb)) add("global-chats", globalDb, true);
    const wsRoot = join(userDir, "workspaceStorage");
    for (const ws of existsSync(wsRoot) ? readdirSync(wsRoot) : []) {
      const db = join(wsRoot, ws, "state.vscdb");
      if (existsSync(db)) add(`workspaces/${ws}`, db, false);
    }
    return items;
  },
  async readRaw(item) {
    return Buffer.from(JSON.stringify(extractChatRows(item.path, item.key === "global-chats")));
  },
  async parse() {
    return [];
  },
};
