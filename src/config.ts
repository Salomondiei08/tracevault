/**
 * User configuration and local state, kept in ~/.tracevault (or $TRACEVAULT_HOME).
 *
 * config.json  where to upload and what to skip (safe to share; holds no secrets)
 * state.json   what has already been uploaded, so syncs only send changes
 * raw.key      the raw-tier encryption key (never uploaded, back it up yourself)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface GcsStorageConfig {
  type: "gcs";
  bucket: string;
  prefix?: string;
}
export interface S3StorageConfig {
  type: "s3";
  bucket: string;
  prefix?: string;
  /** Custom endpoint for non-AWS providers, e.g. https://<account>.r2.cloudflarestorage.com */
  endpoint?: string;
  region?: string;
  /** Named profile in ~/.aws/credentials. */
  profile?: string;
}
export interface LocalStorageConfig {
  type: "local";
  dir: string;
}
export type StorageConfig = GcsStorageConfig | S3StorageConfig | LocalStorageConfig;

export interface Config {
  storage: StorageConfig;
  /** Folder name for this person's data, so many contributors can share one bucket. */
  contributor: string;
  /** Sessions modified more recently than this are skipped until the next run (still being written). */
  idleMinutes: number;
  /** Skip sessions whose working directory contains any of these substrings. */
  excludePaths: string[];
  /** Literal strings always removed from traces (your name, company, client names...). */
  denylist: string[];
  /** Upload the encrypted raw tier as well as redacted traces. */
  uploadRaw: boolean;
}

export const appHome = (): string => process.env.TRACEVAULT_HOME ?? join(homedir(), ".tracevault");
export const configPath = (): string => join(appHome(), "config.json");
export const statePath = (): string => join(appHome(), "state.json");
export const keyPath = (): string => join(appHome(), "raw.key");

/** A default contributor id that does not reveal the username: a short hash of user + host. */
export function defaultContributor(): string {
  return "u-" + createHash("sha256").update(`${homedir()}@${hostname()}`).digest("hex").slice(0, 10);
}

export function loadConfig(): Config | undefined {
  if (!existsSync(configPath())) return undefined;
  const raw = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<Config>;
  if (!raw.storage) throw new Error(`${configPath()} has no "storage" section. Run \`tracevault init\`.`);
  return {
    storage: raw.storage,
    contributor: raw.contributor ?? defaultContributor(),
    idleMinutes: raw.idleMinutes ?? 30,
    excludePaths: raw.excludePaths ?? [],
    denylist: raw.denylist ?? [],
    uploadRaw: raw.uploadRaw ?? true,
  };
}

export function saveConfig(cfg: Config): void {
  mkdirSync(appHome(), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n");
}

/** Per-item upload record: the fingerprint last uploaded for each tier. */
export interface ItemState {
  fingerprint: string;
  rawUploaded?: boolean;
  traceUploaded?: boolean;
  sessions?: number;
}
export type State = Record<string, ItemState>;

export function loadState(): State {
  return existsSync(statePath()) ? (JSON.parse(readFileSync(statePath(), "utf8")) as State) : {};
}

export function saveState(state: State): void {
  mkdirSync(appHome(), { recursive: true, mode: 0o700 });
  writeFileSync(statePath(), JSON.stringify(state));
}
