/**
 * Storage backends. tracevault only needs four operations, so any object store fits:
 * Google Cloud Storage, anything S3-compatible (AWS, Cloudflare R2, Contabo, Backblaze B2,
 * MinIO), a token-scoped write-only intake server, or a plain local folder.
 */
import type { StorageConfig } from "../config";
import { GcsStorage } from "./gcs";
import { IntakeStorage } from "./intake";
import { LocalStorage } from "./local";
import { S3Storage } from "./s3";

export interface Storage {
  /** Human-readable location, e.g. "gs://bucket/prefix". */
  describe(): string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Lists object keys (relative to the configured prefix) under `prefix`. */
  list(prefix: string): Promise<string[]>;
}

/** Error wrapper to abort `withRetry` immediately on fatal client errors (e.g., 401/403/413). */
export class FatalStorageError extends Error {
  readonly nonRetryable = true;
}

/** Joins a configured prefix and a key without doubled or leading slashes. */
export function joinKey(prefix: string | undefined, key: string): string {
  return [prefix, key]
    .filter((p): p is string => Boolean(p))
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .join("/");
}

export function createStorage(cfg: StorageConfig): Storage {
  switch (cfg.type) {
    case "gcs":
      return new GcsStorage(cfg.bucket, cfg.prefix);
    case "s3":
      return new S3Storage(cfg);
    case "local":
      return new LocalStorage(cfg.dir);
    case "intake":
      return new IntakeStorage(cfg.url);
  }
}

/** Retries an async operation with exponential backoff; flaky connections are the norm, not the exception. */
export async function withRetry<T>(what: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if ((err as { nonRetryable?: boolean })?.nonRetryable) throw err;
      last = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw new Error(`${what} failed after ${attempts} attempts: ${(last as Error)?.message ?? String(last)}`);
}
