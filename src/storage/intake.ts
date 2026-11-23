/**
 * Write-only contributor backend via the tracevault intake service.
 *
 * Friends authenticate with an invite token scoped strictly to their own
 * `contributors/<id>/` prefix and receive short-lived signed PUT URLs without ever
 * holding bucket credentials or gcloud/AWS access.
 */
import { loadIntakeToken } from "../config";
import { FatalStorageError, withRetry, type Storage } from "./index";

export interface IntakeWhoami {
  contributor: string;
  allowRaw: boolean;
  maxBytes: number;
}

interface UploadUrlResponse {
  uploadUrl: string;
  method?: string;
  headers?: Record<string, string>;
}

/** Normalizes and validates the intake base URL, requiring HTTPS except for local loopback testing. */
export function normalizeIntakeUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid intake URL: ${rawUrl}`);
  }
  const isLoopback = parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]");
  if (parsed.protocol !== "https:" && !isLoopback) {
    throw new Error("Intake URL must use https:// (http:// is allowed only for localhost/127.0.0.1 testing).");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function throwForHttpStatus(what: string, status: number, text: string): never {
  const msg = `${what} failed (${status}): ${text}`;
  if (status >= 400 && status < 500 && status !== 429) {
    throw new FatalStorageError(msg);
  }
  throw new Error(msg);
}

/** Verifies an intake token against `/v1/whoami` and returns contributor & upload policy. */
export async function intakeWhoami(url: string, token: string): Promise<IntakeWhoami> {
  const base = normalizeIntakeUrl(url);
  const res = await fetch(`${base}/v1/whoami`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token.trim()}` },
  });
  if (!res.ok) throwForHttpStatus("intake whoami", res.status, await res.text());
  return (await res.json()) as IntakeWhoami;
}

export class IntakeStorage implements Storage {
  private readonly baseUrl: string;
  private readonly explicitToken?: string;

  constructor(url: string, token?: string) {
    this.baseUrl = normalizeIntakeUrl(url);
    this.explicitToken = token?.trim();
  }

  describe(): string {
    return `intake:${this.baseUrl}`;
  }

  private token(): string {
    const t = this.explicitToken ?? loadIntakeToken();
    if (!t) throw new FatalStorageError("Missing intake token. Pass --token <token> to `tracevault init --intake ...` or set TRACEVAULT_INTAKE_TOKEN.");
    return t;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const relPath = key.replace(/^contributors\/[^/]+\//, "");
    const target = await withRetry(`mint upload url ${relPath}`, async () => {
      const res = await fetch(`${this.baseUrl}/v1/upload-url`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: relPath, contentType, contentLength: body.length }),
      });
      if (!res.ok) throwForHttpStatus(`mint upload url ${relPath}`, res.status, await res.text());
      return (await res.json()) as UploadUrlResponse;
    });

    await withRetry(`upload ${relPath}`, async () => {
      const res = await fetch(target.uploadUrl, {
        method: target.method ?? "PUT",
        headers: { "Content-Type": contentType, ...(target.headers ?? {}) },
        body,
      });
      if (!res.ok) throwForHttpStatus(`upload ${relPath}`, res.status, await res.text());
    });
  }

  async get(_key: string): Promise<Buffer> {
    throw new Error("Intake contributors have write-only access; export and restore run from the bucket owner's machine.");
  }

  async list(_prefix: string): Promise<string[]> {
    throw new Error("Intake contributors have write-only access; export and restore run from the bucket owner's machine.");
  }
}
