#!/usr/bin/env node
/**
 * tracevault command-line interface.
 *
 *   tracevault scan                 what's on this machine (uploads nothing)
 *   tracevault preview <agent>      show a redacted session, to check what would be shared
 *   tracevault init --gcs <bucket>  choose where data goes
 *   tracevault sync                 upload new and changed sessions
 *   tracevault export --out f.jsonl build a fine-tuning dataset from uploaded traces
 *   tracevault restore <object>     decrypt a raw-tier object back to its original file
 *   tracevault doctor [--fix]       find agents that delete history
 *   tracevault schedule             run sync every night
 */
import { writeFileSync, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ADAPTERS, selectAdapters } from "./adapters";
import { defaultContributor, keyPath, loadConfig, loadState, saveConfig, type Config, type StorageConfig } from "./config";
import { decompressTrace, loadOrCreateKey, openRaw } from "./crypto";
import { checkClaudeRetention } from "./doctor";
import { keepSession, toSftLine } from "./export";
import { redactSession } from "./redact";
import { installSchedule } from "./schedule";
import { createStorage } from "./storage";
import { sync } from "./sync";
import type { TraceSession } from "./types";

const HELP = `tracevault: collect your coding-agent sessions into a private, training-ready archive

Commands
  scan                         List agents and sessions found on this machine. Uploads nothing.
  preview <agent> [--index N]  Print one session after redaction, exactly as it would be uploaded.
  init  --gcs <bucket> | --s3 <bucket> [--endpoint URL] [--region R] [--profile P] | --local <dir>
        [--prefix P] [--contributor NAME] [--no-raw]
                               Write ~/.tracevault/config.json and create the raw-tier key.
  sync  [--agent A]... [--dry-run] [--include-active] [--force]
                               Upload sessions that changed since the last sync
                               (--force re-uploads everything, e.g. after a parser fix).
  export --out FILE [--contributor NAME | --all] [--agent A]... [--committed-only] [--min-user-turns N]
                               Write an SFT chat dataset (JSONL) from uploaded traces.
  restore <object key> --out FILE
                               Decrypt a raw-tier object with your local key.
  doctor [--fix]               Check for agents configured to delete old sessions.
  schedule [--hour H]          Install a nightly sync (launchd on macOS).
`;

function requireConfig(): Config {
  const cfg = loadConfig();
  if (!cfg) {
    console.error("Not configured yet. Run `tracevault init --gcs <bucket>` (or --s3 / --local) first.");
    process.exit(1);
  }
  return cfg;
}

const fmtBytes = (n: number): string =>
  n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(0)} KB`;

async function cmdScan(): Promise<void> {
  const home = homedir();
  let total = 0;
  console.log("Agent                           Items      Size  Parsed");
  for (const a of ADAPTERS) {
    let items;
    try {
      items = await a.discover(home);
    } catch (err) {
      console.log(`${a.label.padEnd(30)} error: ${(err as Error).message}`);
      continue;
    }
    if (!items.length) continue;
    // Size for database-backed agents is a row count, not bytes.
    const bytes = a.id === "opencode" ? 0 : items.reduce((n, i) => n + i.size, 0);
    total += bytes;
    const parsed = a.id === "cursor" || ["antigravity", "openhands", "cline", "pi"].includes(a.id) ? "raw only" : "yes";
    console.log(`${a.label.padEnd(30)} ${String(items.length).padStart(6)} ${(bytes ? fmtBytes(bytes) : "db").padStart(9)}  ${parsed}`);
  }
  console.log(`\nTotal on disk: ${fmtBytes(total)}. Nothing was uploaded.`);
  for (const f of checkClaudeRetention(home)) if (!f.ok) console.log(`⚠ ${f.message}. Run \`tracevault doctor --fix\`.`);
}

async function cmdPreview(agent: string | undefined, index: number): Promise<void> {
  if (!agent) throw new Error("Usage: tracevault preview <agent> [--index N]");
  const [adapter] = selectAdapters([agent]);
  const items = (await adapter!.discover(homedir())).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const item = items[index];
  if (!item) throw new Error(`No item #${index} for ${agent} (found ${items.length})`);
  const sessions = await adapter!.parse(item);
  if (!sessions.length) {
    console.log(`${item.key}: raw-only (archived encrypted, not parsed)`);
    return;
  }
  const cfg = loadConfig();
  for (const s of sessions) {
    const clean = redactSession(s, { home: homedir(), denylist: cfg?.denylist ?? [] });
    console.log(JSON.stringify({ ...clean, events: clean.events.slice(0, 40) }, null, 2));
    console.log(`\n${clean.events.length} events, ${clean.redactions} redaction(s). Showing the first 40.`);
  }
}

function cmdInit(v: Record<string, string | string[] | boolean | undefined>): void {
  let storage: StorageConfig;
  const prefix = v.prefix as string | undefined;
  if (v.gcs) storage = { type: "gcs", bucket: String(v.gcs), prefix };
  else if (v.s3)
    storage = {
      type: "s3",
      bucket: String(v.s3),
      prefix,
      endpoint: v.endpoint as string | undefined,
      region: v.region as string | undefined,
      profile: v.profile as string | undefined,
    };
  else if (v.local) storage = { type: "local", dir: resolve(String(v.local)) };
  else throw new Error("Choose a destination: --gcs <bucket>, --s3 <bucket> or --local <dir>");

  const existing = loadConfig();
  const cfg: Config = {
    storage,
    contributor: (v.contributor as string | undefined) ?? existing?.contributor ?? defaultContributor(),
    idleMinutes: existing?.idleMinutes ?? 30,
    excludePaths: existing?.excludePaths ?? [],
    denylist: existing?.denylist ?? [],
    uploadRaw: v["no-raw"] ? false : (existing?.uploadRaw ?? true),
  };
  saveConfig(cfg);
  if (cfg.uploadRaw) loadOrCreateKey(keyPath());
  console.log(`Saved config. Destination: ${createStorage(storage).describe()}, contributor "${cfg.contributor}".`);
  if (cfg.uploadRaw) console.log(`Raw-tier key: ${keyPath()}. Back it up (e.g. in a password manager): without it the raw archive cannot be read.`);
}

async function cmdSync(agents: string[], dryRun: boolean, includeActive: boolean, force: boolean): Promise<void> {
  const cfg = requireConfig();
  if (agents.length) selectAdapters(agents); // validates names
  const storage = createStorage(cfg.storage);
  console.log(`${dryRun ? "Dry run" : "Syncing"} to ${storage.describe()}`);
  const r = await sync(cfg, storage, loadState(), { agents, dryRun, includeActive, force, log: (l) => console.log(l) });
  console.log(
    `\n${dryRun ? "Would upload" : "Uploaded"} ${r.uploaded} item(s) (${r.sessions} sessions, ${r.redactions} redactions; raw ${fmtBytes(r.bytesRaw)}, traces ${fmtBytes(r.bytesTraces)}).` +
      ` Unchanged ${r.unchanged}, still active ${r.active}, excluded ${r.excluded}, failed ${r.failed.length}.`,
  );
  if (r.failed.length) process.exitCode = 1;
}

async function cmdExport(v: Record<string, unknown>, agents: string[]): Promise<void> {
  const cfg = requireConfig();
  const out = v.out as string | undefined;
  if (!out) throw new Error("--out FILE is required");
  const storage = createStorage(cfg.storage);
  const prefix = v.all ? "contributors/" : `contributors/${(v.contributor as string | undefined) ?? cfg.contributor}/`;
  const keys = (await storage.list(prefix)).filter((k) => k.includes("/traces/") && k.endsWith(".json.gz"));
  const stream = createWriteStream(out);
  let kept = 0;
  for (const k of keys) {
    const s = JSON.parse(decompressTrace(await storage.get(k))) as TraceSession;
    if (!keepSession(s, { agents, committedOnly: Boolean(v["committed-only"]), minUserTurns: Number(v["min-user-turns"] ?? 1) })) continue;
    const line = toSftLine(s);
    if (line) {
      stream.write(line + "\n");
      kept++;
    }
  }
  await new Promise<void>((r) => stream.end(r));
  console.log(`Wrote ${kept} of ${keys.length} session(s) to ${out}`);
}

async function cmdRestore(objectKey: string | undefined, out: string | undefined): Promise<void> {
  if (!objectKey || !out) throw new Error("Usage: tracevault restore <object key> --out FILE");
  const cfg = requireConfig();
  const sealed = await createStorage(cfg.storage).get(objectKey);
  writeFileSync(out, openRaw(sealed, loadOrCreateKey(keyPath())));
  console.log(`Restored ${objectKey} to ${out}`);
}

function cmdDoctor(fix: boolean): void {
  const findings = checkClaudeRetention(homedir());
  if (!findings.length) console.log("No Claude Code config directories found.");
  for (const f of findings) {
    console.log(`${f.ok ? "✓" : "✗"} ${f.message}`);
    if (!f.ok && fix && f.fix) {
      f.fix();
      console.log("  fixed: transcripts will now be kept");
    }
  }
  if (findings.some((f) => !f.ok) && !fix) console.log("\nRun `tracevault doctor --fix` to keep transcripts indefinitely.");
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      gcs: { type: "string" },
      s3: { type: "string" },
      local: { type: "string" },
      endpoint: { type: "string" },
      region: { type: "string" },
      profile: { type: "string" },
      prefix: { type: "string" },
      contributor: { type: "string" },
      "no-raw": { type: "boolean" },
      agent: { type: "string", multiple: true },
      "dry-run": { type: "boolean" },
      "include-active": { type: "boolean" },
      out: { type: "string" },
      all: { type: "boolean" },
      "committed-only": { type: "boolean" },
      "min-user-turns": { type: "string" },
      index: { type: "string" },
      fix: { type: "boolean" },
      force: { type: "boolean" },
      hour: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, arg] = positionals;
  const agents = values.agent ?? [];

  switch (cmd) {
    case "scan":
      return cmdScan();
    case "preview":
      return cmdPreview(arg, Number(values.index ?? 0));
    case "init":
      return cmdInit(values);
    case "sync":
      return cmdSync(agents, Boolean(values["dry-run"]), Boolean(values["include-active"]), Boolean(values.force));
    case "export":
      return cmdExport(values, agents);
    case "restore":
      return cmdRestore(arg, values.out);
    case "doctor":
      return cmdDoctor(Boolean(values.fix));
    case "schedule":
      console.log(installSchedule(resolve(__filename), Number(values.hour ?? 3)));
      return;
    default:
      console.log(HELP);
  }
}

main().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
