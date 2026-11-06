/**
 * OpenAI Codex CLI / app adapter.
 *
 * Sessions are "rollout" files in `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
 * (and `archived_sessions/`). Each line is `{timestamp, type, payload}`; the
 * conversation itself is in `response_item` records using the Responses API item shapes.
 * Model reasoning is stored encrypted by OpenAI, so only reasoning summaries survive.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Adapter, TraceEvent, TraceSession } from "../types";
import { TRACE_FORMAT_VERSION } from "../types";
import { clip, findFiles, flattenText, itemsFromFiles, obj, readJsonl, str } from "./util";

/**
 * Codex injects instructions and app context as "user" messages. They are tagged as
 * system events so exports do not train on them as if the human typed them.
 */
export function isInjectedContext(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith("# AGENTS.md") ||
    t.startsWith("<environment_context") ||
    t.startsWith("<user_instructions") ||
    t.startsWith("# Applications mentioned") ||
    /^<[a-z_]+>[\s\S]*<\/[a-z_]+>\s*$/.test(t)
  );
}

/** Tool arguments arrive as a JSON string; keep the object when it parses. */
function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Converts the records of one rollout file into a TraceSession. */
export function parseCodexRecords(records: Record<string, unknown>[], fallbackId: string): TraceSession {
  const events: TraceEvent[] = [];
  const models = new Set<string>();
  let sessionId = fallbackId;
  let cwd: string | undefined;
  let agentVersion: string | undefined;
  let gitBranch: string | undefined;
  let interrupts = 0;
  const timestamps: string[] = [];

  for (const r of records) {
    const p = obj(r.payload);
    const ts = str(r.timestamp);
    if (ts) timestamps.push(ts);

    if (r.type === "session_meta") {
      sessionId = str(p.session_id) ?? str(p.id) ?? sessionId;
      cwd ??= str(p.cwd);
      agentVersion ??= str(p.cli_version);
      gitBranch ??= str(obj(p.git).branch);
      continue;
    }
    if (r.type === "turn_context") {
      const m = str(p.model);
      if (m) models.add(m);
      cwd ??= str(p.cwd);
      continue;
    }
    if (r.type === "event_msg") {
      if (p.type === "turn_aborted") interrupts++;
      continue;
    }
    if (r.type !== "response_item") continue;

    switch (p.type) {
      case "message": {
        const text = flattenText(p.content);
        if (!text) break;
        if (p.role === "assistant") events.push({ kind: "assistant", ts, text });
        else if (p.role === "user" && !isInjectedContext(text)) events.push({ kind: "user", ts, text });
        else events.push({ kind: "system", ts, text });
        break;
      }
      case "reasoning": {
        const text = flattenText(p.summary);
        if (text && text !== "[]") events.push({ kind: "reasoning", ts, text });
        break;
      }
      case "function_call":
      case "custom_tool_call":
      case "local_shell_call":
        events.push({
          kind: "tool_call",
          ts,
          id: str(p.call_id) ?? str(p.id) ?? "",
          name: [str(p.namespace), str(p.name) ?? String(p.type)].filter(Boolean).join("."),
          input: parseArgs(p.arguments ?? p.input ?? p.action),
        });
        break;
      case "function_call_output":
      case "custom_tool_call_output":
        events.push({ kind: "tool_result", ts, id: str(p.call_id) ?? "", output: clip(flattenText(parseArgs(p.output))) });
        break;
      default:
        break;
    }
  }

  timestamps.sort();
  return {
    formatVersion: TRACE_FORMAT_VERSION,
    agent: "codex",
    sessionId,
    cwd,
    gitBranch,
    agentVersion,
    models: [...models],
    startedAt: timestamps[0],
    endedAt: timestamps[timestamps.length - 1],
    events,
    labels: { userInterrupts: interrupts },
    redactions: 0,
  };
}

export const codex: Adapter = {
  id: "codex",
  label: "Codex",
  async discover(home) {
    const root = join(home, ".codex");
    const files = [
      ...findFiles(join(root, "sessions"), (n) => n.startsWith("rollout-") && n.endsWith(".jsonl")),
      ...findFiles(join(root, "archived_sessions"), (n) => n.startsWith("rollout-") && n.endsWith(".jsonl")),
    ];
    return itemsFromFiles("codex", root, files);
  },
  async readRaw(item) {
    return readFileSync(item.path);
  },
  async parse(item) {
    const s = parseCodexRecords(readJsonl(item.path), basename(item.path, ".jsonl"));
    return s.events.some((e) => e.kind === "user") ? [s] : [];
  },
};
