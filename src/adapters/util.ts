/** Shared helpers for adapters: finding files and reading JSONL safely. */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { SourceItem } from "../types";

/**
 * Recursively lists files under `root` whose name passes `match`. Follows symlinks
 * (some setups, e.g. several Claude profiles, symlink project folders together)
 * but guards against loops with a visited set.
 */
export function findFiles(root: string, match: (name: string, fullPath: string) => boolean, maxDepth = 8): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let real: string;
    try {
      real = statSync(dir).isDirectory() ? dir : "";
    } catch {
      return;
    }
    if (!real) return;
    const id = `${statSync(dir).dev}:${statSync(dir).ino}`;
    if (seen.has(id)) return;
    seen.add(id);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (st.isFile() && match(name, full)) out.push(full);
    }
  };
  if (existsSync(root)) walk(root, 0);
  return out;
}

/** Builds SourceItems for files, keyed by their path relative to the agent's root. */
export function itemsFromFiles(agent: string, root: string, files: string[]): SourceItem[] {
  const byIno = new Map<string, SourceItem>();
  for (const path of files) {
    const st = statSync(path);
    // The same file reached through two symlinked roots is one session, not two.
    const ino = `${st.dev}:${st.ino}`;
    if (byIno.has(ino)) continue;
    byIno.set(ino, { agent, key: relative(root, path), path, size: st.size, mtimeMs: st.mtimeMs });
  }
  return [...byIno.values()];
}

/** Parses a JSONL file, skipping lines that are not valid JSON (a session may be mid-write). */
export function readJsonl(path: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* partial last line or corrupt record: skip it rather than fail the whole session */
    }
  }
  return out;
}

/** Short stable id for things that have no native id. */
export const shortHash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Narrows unknown JSON to a plain object. */
export const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Turns tool output (string, array of text blocks, or object) into plain text. */
export function flattenText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(flattenText).filter(Boolean).join("\n");
  const o = obj(v);
  if (typeof o.text === "string") return o.text;
  if (o.type === "image" || o.type === "input_image") return "[image]";
  if (o.content !== undefined) return flattenText(o.content);
  return v === undefined || v === null ? "" : JSON.stringify(v);
}

/** Caps very large tool outputs; full content stays in the raw tier. */
export function clip(s: string, max = 20_000): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n[... ${s.length - max} more characters clipped]`;
}

/** Keep SQLite optional for file-only adapters and prohibit writes to agent databases. */
export function openReadOnlyDatabase(path: string): DatabaseSyncType {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(path, { readOnly: true });
}
