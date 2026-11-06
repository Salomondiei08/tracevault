/**
 * Google Cloud Storage backend using the JSON API directly.
 *
 * Auth reuses whatever the user already has: a GOOGLE_OAUTH_ACCESS_TOKEN env var, or the
 * gcloud CLI's login (`gcloud auth print-access-token`). That avoids a heavy SDK and any
 * service-account key files on contributors' machines.
 *
 * Large objects use resumable uploads in 8 MiB chunks so a dropped connection only
 * repeats one chunk, not a 90 MB transcript.
 */
import { execFileSync } from "node:child_process";
import { joinKey, withRetry, type Storage } from "./index";

const API = "https://storage.googleapis.com";
const CHUNK = 8 * 1024 * 1024; // must be a multiple of 256 KiB
const SIMPLE_UPLOAD_MAX = CHUNK;

export class GcsStorage implements Storage {
  private token?: { value: string; expires: number };

  constructor(
    private readonly bucket: string,
    private readonly prefix?: string,
  ) {}

  describe(): string {
    return `gs://${joinKey(this.bucket, this.prefix ?? "")}`;
  }

  /** Returns a cached access token, refreshing it every 45 minutes (tokens last 60). */
  private accessToken(): string {
    if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) return process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
    if (this.token && this.token.expires > Date.now()) return this.token.value;
    let value: string;
    try {
      value = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch {
      throw new Error("Could not get a Google access token. Install the gcloud CLI and run `gcloud auth login`.");
    }
    this.token = { value, expires: Date.now() + 45 * 60 * 1000 };
    return value;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken()}`, ...extra };
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const name = joinKey(this.prefix, key);
    if (body.length <= SIMPLE_UPLOAD_MAX) {
      await withRetry(`upload ${name}`, async () => {
        const url = `${API}/upload/storage/v1/b/${this.bucket}/o?uploadType=media&name=${encodeURIComponent(name)}`;
        const res = await fetch(url, { method: "POST", headers: this.headers({ "Content-Type": contentType }), body });
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      });
      return;
    }
    await this.resumableUpload(name, body, contentType);
  }

  /** Starts a resumable session, then sends chunks, resuming from what the server confirms. */
  private async resumableUpload(name: string, body: Buffer, contentType: string): Promise<void> {
    const session = await withRetry(`start upload ${name}`, async () => {
      const url = `${API}/upload/storage/v1/b/${this.bucket}/o?uploadType=resumable&name=${encodeURIComponent(name)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: this.headers({ "X-Upload-Content-Type": contentType, "X-Upload-Content-Length": String(body.length) }),
      });
      const location = res.headers.get("location");
      if (!res.ok || !location) throw new Error(`${res.status} ${await res.text()}`);
      return location;
    });

    let offset = 0;
    let failures = 0;
    while (offset < body.length) {
      const end = Math.min(offset + CHUNK, body.length);
      try {
        const res = await fetch(session, {
          method: "PUT",
          headers: { "Content-Range": `bytes ${offset}-${end - 1}/${body.length}` },
          body: body.subarray(offset, end),
        });
        if (res.status === 200 || res.status === 201) return;
        if (res.status !== 308) throw new Error(`${res.status} ${await res.text()}`);
        // 308 = chunk accepted; the Range header says how much the server actually has.
        const range = res.headers.get("range");
        offset = range ? Number(range.split("-")[1]) + 1 : end;
        failures = 0;
      } catch (err) {
        if (++failures > 6) throw new Error(`upload ${name} failed: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** failures));
        offset = await this.confirmedOffset(session, body.length);
      }
    }
  }

  /** Asks the server how many bytes of a resumable upload it has stored. */
  private async confirmedOffset(session: string, total: number): Promise<number> {
    const res = await fetch(session, { method: "PUT", headers: { "Content-Range": `bytes */${total}` } });
    if (res.status === 200 || res.status === 201) return total;
    const range = res.headers.get("range");
    return range ? Number(range.split("-")[1]) + 1 : 0;
  }

  async get(key: string): Promise<Buffer> {
    const name = joinKey(this.prefix, key);
    return withRetry(`download ${name}`, async () => {
      const res = await fetch(`${API}/storage/v1/b/${this.bucket}/o/${encodeURIComponent(name)}?alt=media`, { headers: this.headers() });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return Buffer.from(await res.arrayBuffer());
    });
  }

  async list(prefix: string): Promise<string[]> {
    const full = joinKey(this.prefix, prefix);
    const out: string[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ prefix: full, fields: "items(name),nextPageToken" });
      if (pageToken) params.set("pageToken", pageToken);
      const data = await withRetry(`list ${full}`, async () => {
        const res = await fetch(`${API}/storage/v1/b/${this.bucket}/o?${params}`, { headers: this.headers() });
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        return (await res.json()) as { items?: { name: string }[]; nextPageToken?: string };
      });
      const strip = this.prefix ? joinKey(this.prefix, "").length + 1 : 0;
      for (const item of data.items ?? []) out.push(item.name.slice(strip));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return out;
  }
}
