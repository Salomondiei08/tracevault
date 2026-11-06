/**
 * Gemini CLI adapter.
 *
 * Saved chats live in `~/.gemini/tmp/<project hash>/chats/session-*.json` as one JSON
 * document: `{sessionId, startTime, lastUpdated, messages: [...]}`. Model turns have
 * `type: "gemini"` with optional `thoughts` and `toolCalls` (each holding its result).
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Adapter, TraceEvent, TraceSession } from "../types";
import { TRACE_FORMAT_VERSION } from "../types";
import { clip, findFiles, flattenText, itemsFromFiles, obj, str } from "./util";

/** Converts one Gemini CLI chat document into a TraceSession. */
export function parseGeminiChat(doc: Record<string, unknown>, fallbackId: string): TraceSession {
  const events: TraceEvent[] = [];
  const models = new Set<string>();
  const messages = Array.isArray(doc.messages) ? doc.messages : [];

  for (const raw of messages) {
    const m = obj(raw);
    const ts = str(m.timestamp);
    const text = flattenText(m.content);
    if (m.type === "user" && text) events.push({ kind: "user", ts, text });
    if (m.type !== "gemini") continue;

    const model = str(m.model);
    if (model) models.add(model);
    for (const t of Array.isArray(m.thoughts) ? m.thoughts : []) {
      const th = obj(t);
      const tt = [str(th.subject), str(th.description)].filter(Boolean).join(": ");
      if (tt) events.push({ kind: "reasoning", ts, text: tt });
    }
    if (text) events.push({ kind: "assistant", ts, text, model });
    for (const c of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
      const call = obj(c);
      const id = str(call.id) ?? "";
      events.push({ kind: "tool_call", ts, id, name: str(call.name) ?? "", input: call.args });
      if (call.result !== undefined) {
        events.push({ kind: "tool_result", ts, id, output: clip(flattenText(call.result)), isError: call.status === "error" });
      }
    }
  }

  return {
    formatVersion: TRACE_FORMAT_VERSION,
    agent: "gemini-cli",
    sessionId: str(doc.sessionId) ?? fallbackId,
    models: [...models],
    startedAt: str(doc.startTime),
    endedAt: str(doc.lastUpdated),
    events,
    labels: {},
    redactions: 0,
  };
}

export const geminiCli: Adapter = {
  id: "gemini-cli",
  label: "Gemini CLI",
  async discover(home) {
    const root = join(home, ".gemini", "tmp");
    const files = findFiles(root, (n) => n.startsWith("session-") && n.endsWith(".json"), 4);
    return itemsFromFiles("gemini-cli", root, files);
  },
  async readRaw(item) {
    return readFileSync(item.path);
  },
  async parse(item) {
    const doc = JSON.parse(readFileSync(item.path, "utf8")) as Record<string, unknown>;
    const s = parseGeminiChat(doc, basename(item.path, ".json"));
    return s.events.some((e) => e.kind === "user") ? [s] : [];
  },
};
