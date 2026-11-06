/**
 * Claude Code adapter.
 *
 * Sessions live in `<config dir>/projects/<encoded cwd>/<session uuid>.jsonl`, one JSON
 * record per line. Users can have several config dirs (CLAUDE_CONFIG_DIR profiles), so
 * every `~/.claude*` dir and `~/.claude-profiles/*` is searched. Subagent runs are
 * separate `agent-*.jsonl` files and become their own sessions.
 *
 * Note: Claude Code deletes transcripts older than `cleanupPeriodDays` (default 30).
 * `tracevault doctor` warns about this.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Adapter, SourceItem, TraceEvent, TraceSession } from "../types";
import { TRACE_FORMAT_VERSION } from "../types";
import { clip, findFiles, flattenText, itemsFromFiles, obj, readJsonl, str } from "./util";

const SESSION_FILE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|agent-[\w-]+)\.jsonl$/;

/** All Claude Code config dirs on this machine. */
export function claudeConfigDirs(home: string): string[] {
  const dirs: string[] = [];
  for (const name of readdirSafe(home)) {
    if (/^\.claude\d*$/.test(name)) dirs.push(join(home, name));
  }
  const profiles = join(home, ".claude-profiles");
  for (const name of readdirSafe(profiles)) dirs.push(join(profiles, name));
  return dirs.filter((d) => existsSync(join(d, "projects")));
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Converts parsed JSONL records of one Claude Code session into a TraceSession. */
export function parseClaudeRecords(records: Record<string, unknown>[], fallbackId: string): TraceSession {
  const events: TraceEvent[] = [];
  const models = new Set<string>();
  let sessionId = fallbackId;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let agentVersion: string | undefined;
  let interrupts = 0;
  const timestamps: string[] = [];

  for (const r of records) {
    const type = r.type;
    if (type !== "user" && type !== "assistant") continue;
    sessionId = str(r.sessionId) ?? sessionId;
    cwd ??= str(r.cwd);
    gitBranch ??= str(r.gitBranch);
    agentVersion ??= str(r.version);
    const ts = str(r.timestamp);
    if (ts) timestamps.push(ts);

    const message = obj(r.message);
    const model = str(message.model);
    if (model && !model.startsWith("<")) models.add(model);
    const content = message.content;

    if (typeof content === "string") {
      if (content.includes("[Request interrupted by user")) interrupts++;
      events.push(
        type === "user"
          ? r.isMeta
            ? { kind: "system", ts, text: content }
            : { kind: "user", ts, text: content }
          : { kind: "assistant", ts, text: content, model },
      );
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const raw of content) {
      const block = obj(raw);
      switch (block.type) {
        case "text": {
          const text = str(block.text) ?? "";
          if (!text) break;
          if (text.includes("[Request interrupted by user")) interrupts++;
          if (type === "assistant") events.push({ kind: "assistant", ts, text, model });
          else events.push(r.isMeta ? { kind: "system", ts, text } : { kind: "user", ts, text });
          break;
        }
        case "thinking": {
          // Thinking is often stored empty (only a signature); keep it only when readable.
          const text = str(block.thinking);
          if (text) events.push({ kind: "reasoning", ts, text });
          break;
        }
        case "tool_use":
          events.push({ kind: "tool_call", ts, id: str(block.id) ?? "", name: str(block.name) ?? "", input: block.input });
          break;
        case "tool_result": {
          const output = clip(flattenText(block.content));
          if (output.includes("doesn't want to proceed") || output.includes("user rejected")) interrupts++;
          events.push({ kind: "tool_result", ts, id: str(block.tool_use_id) ?? "", output, isError: block.is_error === true });
          break;
        }
        default:
          break;
      }
    }
  }

  timestamps.sort();
  return {
    formatVersion: TRACE_FORMAT_VERSION,
    agent: "claude-code",
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

/**
 * Subagent transcripts (`agent-*.jsonl`) carry their parent's sessionId. Without a
 * distinct id they would overwrite the parent's trace in storage, so the file name
 * is appended: `<parent id>/agent-<id>`.
 */
export function withSubagentId(session: TraceSession, path: string): TraceSession {
  const file = basename(path, ".jsonl");
  return file.startsWith("agent-") ? { ...session, sessionId: `${session.sessionId}/${file}` } : session;
}

export const claudeCode: Adapter = {
  id: "claude-code",
  label: "Claude Code",
  async discover(home) {
    const items: SourceItem[] = [];
    for (const dir of claudeConfigDirs(home)) {
      const root = join(dir, "projects");
      const files = findFiles(root, (n) => SESSION_FILE.test(n));
      for (const it of itemsFromFiles("claude-code", root, files)) {
        items.push({ ...it, key: `${basename(dir)}/${it.key}` });
      }
    }
    // Profiles that symlink each other's project folders would otherwise list the same file twice.
    const seen = new Set<string>();
    return items.filter((i) => {
      const id = `${i.size}:${i.mtimeMs}:${basename(i.path)}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  },
  async readRaw(item) {
    return readFileSync(item.path);
  },
  async parse(item) {
    const session = withSubagentId(parseClaudeRecords(readJsonl(item.path), basename(item.path, ".jsonl")), item.path);
    return session.events.length ? [session] : [];
  },
};
