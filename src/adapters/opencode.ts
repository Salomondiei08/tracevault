/**
 * OpenCode adapter.
 *
 * OpenCode keeps everything in one SQLite database (`~/.local/share/opencode/opencode.db`)
 * with `session`, `message` and `part` tables. The same database also stores login
 * tokens (`account`, `credential` tables), so this adapter never archives the database
 * file: each session's raw tier is a JSON extract of only its own session, message and
 * part rows.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { Adapter, SourceItem, TraceEvent, TraceSession } from "../types";
import { TRACE_FORMAT_VERSION } from "../types";
import { clip, flattenText, obj, openReadOnlyDatabase, str } from "./util";

const DB_RELATIVE = [".local", "share", "opencode", "opencode.db"];


interface SessionExtract {
  session: Record<string, unknown>;
  messages: { id: string; time_created: number; data: Record<string, unknown> }[];
  parts: { message_id: string; time_created: number; data: Record<string, unknown> }[];
}

/** Reads one session's rows. Only these three tables are ever touched. */
function extract(db: DatabaseSyncType, sessionId: string): SessionExtract {
  const session = db.prepare("SELECT * FROM session WHERE id = ?").get(sessionId) as Record<string, unknown>;
  const messages = (
    db.prepare("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id").all(sessionId) as {
      id: string;
      time_created: number;
      data: string;
    }[]
  ).map((m) => ({ ...m, data: JSON.parse(m.data) as Record<string, unknown> }));
  const parts = (
    db.prepare("SELECT message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created, id").all(sessionId) as {
      message_id: string;
      time_created: number;
      data: string;
    }[]
  ).map((p) => ({ ...p, data: JSON.parse(p.data) as Record<string, unknown> }));
  return { session, messages, parts };
}

/** Converts one session extract into a TraceSession. */
export function parseOpencodeExtract(x: SessionExtract): TraceSession {
  const events: TraceEvent[] = [];
  const models = new Set<string>();
  const partsByMessage = new Map<string, SessionExtract["parts"]>();
  for (const p of x.parts) {
    const list = partsByMessage.get(p.message_id) ?? [];
    list.push(p);
    partsByMessage.set(p.message_id, list);
  }

  for (const m of x.messages) {
    const role = m.data.role;
    const ts = new Date(m.time_created).toISOString();
    const model = str(m.data.modelID) ?? str(obj(m.data.model).modelID);
    if (model) models.add(model);

    for (const { data: part } of partsByMessage.get(m.id) ?? []) {
      switch (part.type) {
        case "text": {
          const text = str(part.text) ?? "";
          if (!text || part.synthetic) break;
          events.push(role === "user" ? { kind: "user", ts, text } : { kind: "assistant", ts, text, model });
          break;
        }
        case "reasoning": {
          const text = str(part.text);
          if (text) events.push({ kind: "reasoning", ts, text });
          break;
        }
        case "tool": {
          const state = obj(part.state);
          const id = str(part.callID) ?? "";
          events.push({ kind: "tool_call", ts, id, name: str(part.tool) ?? "", input: state.input });
          if (state.output !== undefined || state.error !== undefined) {
            events.push({
              kind: "tool_result",
              ts,
              id,
              output: clip(flattenText(state.output ?? state.error)),
              isError: state.status === "error",
            });
          }
          break;
        }
        default:
          break;
      }
    }
  }

  const s = x.session;
  return {
    formatVersion: TRACE_FORMAT_VERSION,
    agent: "opencode",
    sessionId: String(s.id),
    cwd: str(s.directory),
    agentVersion: str(s.version),
    models: [...models],
    startedAt: typeof s.time_created === "number" ? new Date(s.time_created).toISOString() : undefined,
    endedAt: typeof s.time_updated === "number" ? new Date(s.time_updated).toISOString() : undefined,
    events,
    labels: {},
    redactions: 0,
  };
}

export const opencode: Adapter = {
  id: "opencode",
  label: "OpenCode",
  async discover(home) {
    const dbPath = join(home, ...DB_RELATIVE);
    if (!existsSync(dbPath)) return [];
    const db = openReadOnlyDatabase(dbPath);
    try {
      const rows = db
        .prepare(
          "SELECT s.id AS id, s.time_updated AS updated, (SELECT COUNT(*) FROM part p WHERE p.session_id = s.id) AS parts FROM session s",
        )
        .all() as { id: string; updated: number; parts: number }[];
      // size = part count, so a session that gained parts counts as changed.
      return rows.map((r): SourceItem => ({ agent: "opencode", key: `sessions/${r.id}`, path: dbPath, size: r.parts, mtimeMs: r.updated }));
    } finally {
      db.close();
    }
  },
  async readRaw(item) {
    const db = openReadOnlyDatabase(item.path);
    try {
      return Buffer.from(JSON.stringify(extract(db, item.key.replace("sessions/", ""))));
    } finally {
      db.close();
    }
  },
  async parse(item) {
    const db = openReadOnlyDatabase(item.path);
    try {
      const s = parseOpencodeExtract(extract(db, item.key.replace("sessions/", "")));
      return s.events.some((e) => e.kind === "user") ? [s] : [];
    } finally {
      db.close();
    }
  },
};
