/**
 * The sync pipeline: discover → (skip unchanged or still-active) → parse → label →
 * redact → upload traces → encrypt and upload raw → record state.
 *
 * Layout in the bucket (under the configured prefix):
 *   contributors/<id>/raw/<agent>/<source key>.zst.enc     encrypted originals
 *   contributors/<id>/traces/<agent>/<session id>.json.gz  redacted TraceSession
 *   contributors/<id>/manifest.json                        last sync summary
 */
import { homedir } from "node:os";
import { ADAPTERS } from "./adapters";
import type { Config, State } from "./config";
import { keyPath, saveState } from "./config";
import { compressTrace, loadOrCreateKey, sealRaw } from "./crypto";
import { commitsDuring } from "./git";
import { redactSession } from "./redact";
import type { Storage } from "./storage";
import type { Adapter, SourceItem, TraceSession } from "./types";

export interface SyncOptions {
  agents?: string[];
  dryRun?: boolean;
  /** Ignore the idle window (useful for a one-off full upload). */
  includeActive?: boolean;
  /** Home directory to discover sessions in (defaults to the real one; tests use a fake). */
  home?: string;
  log?: (line: string) => void;
}

export interface SyncReport {
  scanned: number;
  uploaded: number;
  unchanged: number;
  active: number;
  excluded: number;
  failed: { key: string; error: string }[];
  sessions: number;
  redactions: number;
  bytesRaw: number;
  bytesTraces: number;
}

/** Item fingerprint: changes whenever a session file grows or is rewritten. */
export const fingerprint = (item: SourceItem): string => `${item.size}:${Math.floor(item.mtimeMs)}`;

/** Object-store-safe version of a source key. */
export const objectKey = (key: string): string => key.replace(/[^A-Za-z0-9._/-]/g, "_");

function isExcluded(session: TraceSession | undefined, item: SourceItem, cfg: Config): boolean {
  const haystacks = [session?.cwd ?? "", item.path];
  return cfg.excludePaths.some((p) => p && haystacks.some((h) => h.includes(p)));
}

export async function sync(cfg: Config, storage: Storage, state: State, opts: SyncOptions = {}): Promise<SyncReport> {
  const log = opts.log ?? (() => {});
  const home = opts.home ?? homedir();
  const key = cfg.uploadRaw ? loadOrCreateKey(keyPath()) : undefined;
  const base = `contributors/${cfg.contributor}`;
  const report: SyncReport = {
    scanned: 0,
    uploaded: 0,
    unchanged: 0,
    active: 0,
    excluded: 0,
    failed: [],
    sessions: 0,
    redactions: 0,
    bytesRaw: 0,
    bytesTraces: 0,
  };
  const adapters: Adapter[] = opts.agents?.length ? ADAPTERS.filter((a) => opts.agents!.includes(a.id)) : ADAPTERS;
  const idleCutoff = Date.now() - cfg.idleMinutes * 60_000;
  let sinceSave = 0;

  for (const adapter of adapters) {
    let items: SourceItem[];
    try {
      items = await adapter.discover(home);
    } catch (err) {
      report.failed.push({ key: adapter.id, error: `discover: ${(err as Error).message}` });
      continue;
    }
    if (items.length) log(`${adapter.label}: ${items.length} item(s)`);

    for (const item of items) {
      report.scanned++;
      const stateKey = `${item.agent}/${item.key}`;
      const fp = fingerprint(item);
      if (!opts.includeActive && item.mtimeMs > idleCutoff) {
        report.active++;
        continue;
      }
      const prev = state[stateKey];
      if (prev?.fingerprint === fp && prev.traceUploaded && (prev.rawUploaded || !cfg.uploadRaw)) {
        report.unchanged++;
        continue;
      }

      try {
        // Parse first: outcome labels need the real cwd, and exclusions need to know the repo.
        const parsed = await adapter.parse(item);
        if (isExcluded(parsed[0], item, cfg)) {
          report.excluded++;
          continue;
        }
        const traces: { key: string; body: Buffer; session: TraceSession }[] = [];
        for (const s of parsed) {
          const labelled: TraceSession = { ...s, labels: { ...s.labels, commits: commitsDuring(s) } };
          const clean = redactSession(labelled, { home, denylist: cfg.denylist });
          traces.push({
            key: `${base}/traces/${adapter.id}/${objectKey(clean.sessionId)}.json.gz`,
            body: compressTrace(JSON.stringify(clean)),
            session: clean,
          });
        }
        const raw = key ? sealRaw(await adapter.readRaw(item), key) : undefined;

        if (opts.dryRun) {
          log(`  would upload ${stateKey} (${traces.length} trace(s), raw ${raw ? raw.length : 0} B)`);
        } else {
          for (const t of traces) await storage.put(t.key, t.body, "application/gzip");
          if (raw) await storage.put(`${base}/raw/${adapter.id}/${objectKey(item.key)}.zst.enc`, raw, "application/octet-stream");
          state[stateKey] = { fingerprint: fp, traceUploaded: true, rawUploaded: Boolean(raw), sessions: traces.length };
          if (++sinceSave >= 20) {
            saveState(state); // checkpoint so an interrupted first sync does not start over
            sinceSave = 0;
          }
        }
        report.uploaded++;
        report.sessions += traces.length;
        report.redactions += traces.reduce((n, t) => n + t.session.redactions, 0);
        report.bytesRaw += raw?.length ?? 0;
        report.bytesTraces += traces.reduce((n, t) => n + t.body.length, 0);
        if (!opts.dryRun) log(`  ✓ ${stateKey}`);
      } catch (err) {
        report.failed.push({ key: stateKey, error: (err as Error).message });
        log(`  ✗ ${stateKey}: ${(err as Error).message}`);
      }
    }
  }

  if (!opts.dryRun) {
    saveState(state);
    const manifest = { contributor: cfg.contributor, syncedAt: new Date().toISOString(), report };
    // Error messages can contain local paths; hide the home directory like the traces do.
    const body = JSON.stringify(manifest, null, 2).split(home).join("~");
    await storage.put(`${base}/manifest.json`, Buffer.from(body), "application/json");
  }
  return report;
}
