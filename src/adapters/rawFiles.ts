/**
 * Adapters for agents whose logs are archived as-is (raw tier only) until a dedicated
 * parser exists. Archiving early matters more than parsing early: most agents prune old
 * history, and a parser can always be written later against the archived raw files.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, SourceItem } from "../types";
import { parseClaudeRecords, withSubagentId } from "./claudeCode";
import { findFiles, itemsFromFiles, readJsonl } from "./util";

interface RawSpec {
  id: string;
  label: string;
  /** Directories relative to home, each searched recursively. */
  roots: string[];
  /** Decides whether a file is part of a session, given its name and full path. */
  match: (name: string, fullPath: string) => boolean;
  /** Optional parser for raw files that happen to share a known format. */
  parse?: Adapter["parse"];
}

/** Builds an adapter that finds files under fixed roots and archives them unchanged. */
export function rawFileAdapter(spec: RawSpec): Adapter {
  return {
    id: spec.id,
    label: spec.label,
    async discover(home) {
      const items: SourceItem[] = [];
      for (const rel of spec.roots) {
        const root = join(home, rel);
        const files = findFiles(root, spec.match, 10);
        items.push(...itemsFromFiles(spec.id, home, files));
      }
      return items;
    },
    async readRaw(item) {
      return readFileSync(item.path);
    },
    parse: spec.parse ?? (async () => []),
  };
}

const MAC_SUPPORT = join("Library", "Application Support");

export const rawAdapters: Adapter[] = [
  rawFileAdapter({
    id: "claude-desktop",
    label: "Claude Desktop (agent sessions)",
    roots: [join(MAC_SUPPORT, "Claude", "local-agent-mode-sessions"), join(MAC_SUPPORT, "Claude", "claude-code-sessions")],
    match: (n) => n.endsWith(".jsonl"),
    // Desktop agent sessions use the Claude Code transcript format; parse when it fits.
    async parse(item) {
      const s = withSubagentId(parseClaudeRecords(readJsonl(item.path), item.key), item.path);
      return s.events.some((e) => e.kind === "user") ? [{ ...s, agent: "claude-desktop" }] : [];
    },
  }),
  rawFileAdapter({
    id: "antigravity",
    label: "Antigravity",
    roots: [join(".gemini", "antigravity")],
    match: (n, p) =>
      (n.endsWith(".pb") && /\/(conversations|implicit)\//.test(p)) ||
      (/\/brain\//.test(p) && (n.endsWith(".jsonl") || n.endsWith(".json"))),
  }),
  rawFileAdapter({
    id: "openhands",
    label: "OpenHands",
    roots: [join(".openhands", "sessions")],
    match: (n) => n.endsWith(".json"),
  }),
  rawFileAdapter({
    id: "cline",
    label: "Cline",
    roots: [join(".cline", "data", "sessions"), join(MAC_SUPPORT, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "tasks")],
    match: (n) => n.endsWith(".json"),
  }),
  rawFileAdapter({
    id: "pi",
    label: "Pi",
    roots: [join(".pi", "agent", "sessions")],
    match: (n) => n.endsWith(".jsonl"),
  }),
];
