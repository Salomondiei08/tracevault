/**
 * Minimal zero-dependency friend intake HTTP server.
 *
 * Friends present per-user bearer tokens and receive short-lived signed PUT targets
 * strictly locked to `contributors/<token-contributor>/...`. Friends can neither spoof
 * another contributor's folder nor read/list anything in the bucket.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export interface TokenEntry {
  contributor: string;
  allowRaw?: boolean;
  maxBytes?: number;
}

export interface UploadTargetArgs {
  objectName: string;
  contributor: string;
  relativePath: string;
  contentType: string;
  contentLength: number;
  baseUrl: string;
}

export interface IntakeServerOptions {
  /** Map of SHA-256 hex(token) -> contributor policy. */
  tokens: Record<string, TokenEntry>;
  /** Bucket prefix if shared, e.g. "prod". */
  prefix?: string;
  /** Default max upload size per object in bytes (default 25 MiB). */
  defaultMaxBytes?: number;
  /** Max mint requests per contributor per hour (default 600). */
  rateLimitPerHour?: number;
  /** Custom signed URL generator (e.g. GCS V4 signer). */
  createUploadTarget?: (args: UploadTargetArgs) => Promise<{ uploadUrl: string; method?: string; headers?: Record<string, string> }>;
  /** Optional local directory sink for hermetic testing or standalone VPS hosting. */
  localDir?: string;
  /** Secret for signing loopback `/v1/local-put` URLs when `localDir` is used. */
  localPutSecret?: Buffer;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_RATE_LIMIT_PER_HOUR = 600;
const RELATIVE_PATH_RE = /^(?:traces\/[a-z0-9-]+\/[A-Za-z0-9._/-]+\.json\.gz|raw\/[a-z0-9-]+\/[A-Za-z0-9._/-]+\.zst\.enc|manifest\.json)$/;

/** Returns SHA-256 hex digest of a contributor token. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

/** Enforces safe contributor-relative paths and blocks raw-tier uploads unless enabled. */
export function validateRelativePath(relPath: string, allowRaw: boolean): { ok: true } | { ok: false; status: number; error: string } {
  if (!relPath || relPath.includes("\\") || relPath.startsWith("/")) {
    return { ok: false, status: 403, error: "Invalid relative object path" };
  }
  const segments = relPath.split("/");
  if (segments.some((s) => !s || s === "." || s === "..")) {
    return { ok: false, status: 403, error: "Path traversal rejected" };
  }
  if (!RELATIVE_PATH_RE.test(relPath)) {
    return { ok: false, status: 403, error: "Object path must target traces/<agent>/*.json.gz, raw/<agent>/*.zst.enc, or manifest.json" };
  }
  if (relPath.startsWith("raw/") && !allowRaw) {
    return { ok: false, status: 403, error: "Raw tier uploads are disabled for this contributor token (--no-raw)" };
  }
  return { ok: true };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw Object.assign(new Error("Request body exceeds maximum size"), { status: 413 });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

interface LocalPutPayload {
  objectName: string;
  contentType: string;
  contentLength: number;
  exp: number;
}

/** Creates the HTTP server handling `/healthz`, `/v1/whoami`, `/v1/upload-url`, and optional `/v1/local-put`. */
export function createIntakeServer(opts: IntakeServerOptions): Server {
  const defaultMaxBytes = opts.defaultMaxBytes ?? DEFAULT_MAX_BYTES;
  const rateLimitPerHour = opts.rateLimitPerHour ?? DEFAULT_RATE_LIMIT_PER_HOUR;
  const localSecret = opts.localPutSecret ?? randomBytes(32);
  const localRoot = opts.localDir ? resolve(opts.localDir) : undefined;
  const tokenEntries: { digest: Buffer; entry: TokenEntry }[] = Object.entries(opts.tokens)
    .filter(([hex]) => /^[a-f0-9]{64}$/i.test(hex))
    .map(([hex, entry]) => ({ digest: Buffer.from(hex, "hex"), entry }));

  const rateWindows = new Map<string, number[]>();

  function authenticate(req: IncomingMessage): TokenEntry | undefined {
    const auth = req.headers.authorization ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(auth);
    if (!match?.[1]) return undefined;
    const candidate = createHash("sha256").update(match[1], "utf8").digest();
    let matched: TokenEntry | undefined;
    for (const item of tokenEntries) {
      if (item.digest.length === candidate.length && timingSafeEqual(item.digest, candidate)) {
        matched = item.entry;
      }
    }
    return matched;
  }

  function checkRateLimit(contributor: string): boolean {
    const now = Date.now();
    const cutoff = now - 3_600_000;
    const prev = (rateWindows.get(contributor) ?? []).filter((ts) => ts > cutoff);
    if (prev.length >= rateLimitPerHour) {
      rateWindows.set(contributor, prev);
      return false;
    }
    prev.push(now);
    rateWindows.set(contributor, prev);
    return true;
  }

  function signLocalPut(payload: LocalPutPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const sig = createHmac("sha256", localSecret).update(encoded).digest("base64url");
    return `${encoded}.${sig}`;
  }

  function verifyLocalPut(token: string): LocalPutPayload | undefined {
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
    const expected = createHmac("sha256", localSecret).update(parts[0]).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(parts[1], "base64url");
    } catch {
      return undefined;
    }
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return undefined;
    try {
      const parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as LocalPutPayload;
      if (Date.now() > parsed.exp) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const protoHeader = req.headers["x-forwarded-proto"];
      const proto = (typeof protoHeader === "string" ? protoHeader.split(",")[0]?.trim() : undefined) || "http";
      const baseUrl = `${proto}://${req.headers.host ?? "127.0.0.1"}`;

      if (req.method === "GET" && url.pathname === "/healthz") {
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === "PUT" && url.pathname === "/v1/local-put") {
        if (!localRoot) return sendJson(res, 404, { error: "Local upload mode is disabled" });
        const tokenParam = url.searchParams.get("t");
        const signed = tokenParam ? verifyLocalPut(tokenParam) : undefined;
        if (!signed) return sendJson(res, 403, { error: "Invalid or expired local upload token" });
        const body = await readBody(req, signed.contentLength);
        if (body.length !== signed.contentLength) {
          return sendJson(res, 400, { error: "Uploaded size does not match declared contentLength" });
        }
        const dest = resolve(localRoot, signed.objectName);
        const rel = relative(localRoot, dest);
        if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
          return sendJson(res, 403, { error: "Invalid storage destination" });
        }
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, body);
        return sendJson(res, 200, { ok: true });
      }

      const authEntry = authenticate(req);
      if (!authEntry) return sendJson(res, 401, { error: "Unauthorized" });

      const allowRaw = Boolean(authEntry.allowRaw);
      const maxBytes = authEntry.maxBytes ?? defaultMaxBytes;

      if (req.method === "GET" && url.pathname === "/v1/whoami") {
        return sendJson(res, 200, { contributor: authEntry.contributor, allowRaw, maxBytes });
      }

      if (req.method === "POST" && url.pathname === "/v1/upload-url") {
        if (!checkRateLimit(authEntry.contributor)) {
          return sendJson(res, 429, { error: "Rate limit exceeded; retry next hour" });
        }
        const rawBody = await readBody(req, 32 * 1024);
        let parsed: { path?: unknown; contentType?: unknown; contentLength?: unknown };
        try {
          parsed = JSON.parse(rawBody.toString("utf8")) as { path?: unknown; contentType?: unknown; contentLength?: unknown };
        } catch {
          return sendJson(res, 400, { error: "Body must be valid JSON" });
        }

        if (typeof parsed.path !== "string" || typeof parsed.contentType !== "string" || typeof parsed.contentLength !== "number") {
          return sendJson(res, 400, { error: "Expected path (string), contentType (string), contentLength (number)" });
        }
        if (!Number.isInteger(parsed.contentLength) || parsed.contentLength < 0) {
          return sendJson(res, 400, { error: "contentLength must be a non-negative integer" });
        }
        if (parsed.contentLength > maxBytes) {
          return sendJson(res, 413, { error: `Object size ${parsed.contentLength} exceeds limit of ${maxBytes} bytes` });
        }

        const check = validateRelativePath(parsed.path, allowRaw);
        if (!check.ok) return sendJson(res, check.status, { error: check.error });

        const cleanPrefix = opts.prefix ? opts.prefix.replace(/^\/+|\/+$/g, "") + "/" : "";
        const objectName = `${cleanPrefix}contributors/${authEntry.contributor}/${parsed.path}`;

        if (opts.createUploadTarget) {
          const target = await opts.createUploadTarget({
            objectName,
            contributor: authEntry.contributor,
            relativePath: parsed.path,
            contentType: parsed.contentType,
            contentLength: parsed.contentLength,
            baseUrl,
          });
          return sendJson(res, 200, target);
        }

        if (localRoot) {
          const token = signLocalPut({
            objectName,
            contentType: parsed.contentType,
            contentLength: parsed.contentLength,
            exp: Date.now() + 300_000,
          });
          return sendJson(res, 200, {
            uploadUrl: `${baseUrl}/v1/local-put?t=${encodeURIComponent(token)}`,
            method: "PUT",
            headers: { "Content-Type": parsed.contentType },
          });
        }

        return sendJson(res, 500, { error: "Server has no upload backend configured" });
      }

      return sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      if (!res.headersSent) return sendJson(res, status, { error: message });
      res.end();
    }
  });
}
