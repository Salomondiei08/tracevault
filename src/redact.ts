/**
 * Secret and personal-data redaction for normalized traces.
 *
 * Agent transcripts routinely contain secrets: `.env` files the agent read, tokens
 * echoed in tool output, connection strings in configs. Redaction errs on the side
 * of removing too much, because a training set with a few extra `[REDACTED]` markers
 * is harmless, while one leaked key is not.
 */
import type { TraceEvent, TraceSession } from "./types";

interface Rule {
  name: string;
  pattern: RegExp;
  /** Index of the capture group holding the secret; 0 means the whole match. */
  group?: number;
  /** Returns true when the captured value is clearly not a secret (e.g. code). */
  keep?: (value: string) => boolean;
}

/**
 * `password = form.get("password")` or `token: string` is code, not a secret. Values
 * that are calls, property paths, type names or literals are kept.
 */
export function looksLikeCode(value: string): boolean {
  return (
    /[()[\]<>]/.test(value) ||
    /^[A-Za-z_$][\w$]*(\.[\w$]+)+$/.test(value) || // process.env.X, config.auth.token
    /^\$\{?[\w.]+\}?$/.test(value) || // $VAR, ${VAR}
    /^(true|false|null|undefined|none|string|number|boolean|required|optional|redacted|changeme|bearer|basic|xxxxxx+|\*+)$/i.test(value) ||
    /^(YOUR|MY|<)[A-Z_]*/.test(value) // placeholders like YOUR_API_KEY
  );
}

/** Well-known token shapes. Order matters: specific provider formats run before generic ones. */
export const RULES: Rule[] = [
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "anthropic", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openrouter", pattern: /\bsk-or-v1-[a-f0-9]{32,}\b/g },
  { name: "openai", pattern: /sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { name: "supabase", pattern: /\bsbp_[a-f0-9]{40}\b/g },
  { name: "resend", pattern: /\bre_[A-Za-z0-9_]{24,}\b/g },
  { name: "vercel", pattern: /\b(?:vcp_|vercel_)[A-Za-z0-9_-]{24,}\b/g },
  { name: "telegram-bot", pattern: /\b\d{8,11}:[A-Za-z0-9_-]{35}\b/g },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "google-oauth", pattern: /\bya29\.[0-9A-Za-z_-]{20,}/g },
  { name: "github", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { name: "gitlab", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { name: "slack", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: "stripe", pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: "hf", pattern: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { name: "npm", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // HTTP auth headers: the token after the scheme is the secret, not the word "Bearer".
  { name: "auth-header", pattern: /\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{16,})/g, group: 2 },
  // user:password@host in database and broker URLs.
  { name: "url-credentials", pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})(@)/gi, group: 2 },
  // KEY=value and "key": "value" where the name says it is secret.
  {
    name: "secret-assignment",
    pattern:
      /\b([A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH|CREDENTIALS?)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)([^\s"',;}{]{6,})/gi,
    group: 2,
    keep: looksLikeCode,
  },
  { name: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // International phone numbers (+225 07 00 00 00 00, +1 415 555 0100, ...).
  { name: "phone", pattern: /\+\d{1,3}[\s.-]?(?:\d[\s.-]?){7,12}\d\b/g },
  // Private RFC 1918 and Tailscale CGNAT (100.64.0.0/10) IPv4 addresses; keeps loopback (127.0.0.1) & semver (10.8.0).
  {
    name: "private-ip",
    pattern:
      /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/g,
  },
];

/**
 * Values that look like secrets by randomness alone. "/" is deliberately not part of the
 * alphabet: file paths are the most useful context in coding traces and must survive.
 */
const HIGH_ENTROPY_CANDIDATE = /[A-Za-z0-9_-]{32,}={0,2}/g;

/** Random API tokens mix upper case, lower case and digits; slugs and path segments rarely do. */
const looksRandom = (s: string): boolean => /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s) && entropy(s) >= 4.3;

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Hex digests (git SHAs, content hashes) and UUIDs are high-entropy but not secret,
 * and they carry useful meaning in coding traces, so they are kept.
 */
function looksLikeHarmlessId(s: string): boolean {
  return /^[0-9a-f]+$/i.test(s) || /^[0-9a-f-]{36}$/i.test(s) || /^[A-Za-z_]+$/.test(s);
}

const GENERIC_USERNAMES = new Set(["user", "root", "admin", "home", "ubuntu", "runner"]);

function applyHomeRedaction(input: string, home: string): string {
  const trimmed = home.replace(/[\\/]+$/, "");
  if (!trimmed) return input;
  const slashVariants = new Set<string>([trimmed, trimmed.replace(/\\/g, "\\\\"), trimmed.replace(/\\/g, "/")]);
  let out = input;
  // Longest first so JSON-escaped backslashes (`C:\\Users\\...`) are matched before single ones.
  for (const v of [...slashVariants].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length)) {
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`${esc}(?:\\\\\\\\|\\\\|/)`, "g"), "~/");
    out = out.split(v).join("~");
  }
  const dashed = trimmed.replace(/[:\\/]+/g, "-");
  if (dashed.length >= 4) {
    out = out.split(dashed).join("~");
  }
  return out;
}

export interface RedactOptions {
  /** Home directory to replace with "~", which also hides the OS username. */
  home?: string;
  /** Extra literal strings to always remove (names, company names, hostnames). */
  denylist?: string[];
}

/** Redacts one string and reports how many replacements were made. */
export function redactText(input: string, opts: RedactOptions = {}): { text: string; count: number } {
  // Home paths first: a temp or home dir can itself look random and would otherwise be
  // replaced by an entropy marker, losing the useful "~/project/file" shape.
  let text = opts.home ? applyHomeRedaction(input, opts.home) : input;
  let count = 0;

  for (const rule of RULES) {
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      const match = args[0] as string;
      if (!rule.group) {
        count++;
        return `[REDACTED:${rule.name}]`;
      }
      const secret = args[rule.group] as string;
      if (rule.keep?.(secret)) return match;
      count++;
      return match.replace(secret, `[REDACTED:${rule.name}]`);
    });
  }

  if (opts.home) {
    const user = opts.home.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
    if (user.length >= 3 && !GENERIC_USERNAMES.has(user.toLowerCase())) {
      const escapedUser = user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const userHostRe = new RegExp(`(?<![A-Za-z0-9._-])${escapedUser}@[A-Za-z0-9._-]+`, "g");
      text = text.replace(userHostRe, () => {
        count++;
        return "~@[REDACTED:host]";
      });
    }
  }

  text = text.replace(HIGH_ENTROPY_CANDIDATE, (m) => {
    if (looksLikeHarmlessId(m) || m.includes("REDACTED") || !looksRandom(m)) return m;
    count++;
    return "[REDACTED:high-entropy]";
  });

  for (const word of opts.denylist ?? []) {
    if (!word) continue;
    const re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    text = text.replace(re, () => {
      count++;
      return "[REDACTED:denylist]";
    });
  }

  return { text, count };
}

/** Returns true when `filePath` points to an env/secret/key file whose contents should never be uploaded. */
export function isSensitiveFilePath(filePath: string): boolean {
  const norm = filePath.trim().replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
  if (!norm) return false;
  if (/\.(?:example|sample|template|dist)$/i.test(norm)) return false;
  if (/\.pub$/i.test(norm)) return false;
  return (
    /(?:^|\/)\.env(?:\.[A-Za-z0-9._-]+)?$/i.test(norm) ||
    /(?:^|\/)\.ssh\/id_[^/]+$/i.test(norm) ||
    /(?:^|\/)\.aws\/credentials$/i.test(norm) ||
    /(?:^|\/)\.(?:netrc|npmrc|pypirc)$/i.test(norm) ||
    /(?:^|\/)\.tracevault\/(?:raw\.key|intake\.token)$/i.test(norm) ||
    /(?:^|\/)\.hermes\/auth\.json$/i.test(norm) ||
    /\.(?:pem|p12|pfx)$/i.test(norm) ||
    /(?:^|\/)service-account[^/]*\.json$/i.test(norm)
  );
}

const PATH_KEYS = new Set(["file_path", "path", "file", "target_file", "filename", "filepath"]);

/** Returns true when a tool_call's arguments inspect a known secret/env/key file. */
export function toolCallTargetsSensitiveFile(input: unknown): boolean {
  if (typeof input === "string") return isSensitiveFilePath(input);
  if (Array.isArray(input)) return input.some((item) => toolCallTargetsSensitiveFile(item));
  if (input && typeof input === "object") {
    for (const [key, val] of Object.entries(input)) {
      if (PATH_KEYS.has(key) && typeof val === "string" && isSensitiveFilePath(val)) return true;
      if ((key === "command" || key === "cmd") && typeof val === "string") {
        const tokens = val.split(/[\s=;|&<>()"']+/);
        if (tokens.some((t) => isSensitiveFilePath(t))) return true;
      }
      if (toolCallTargetsSensitiveFile(val)) return true;
    }
  }
  return false;
}

/** Redacts any JSON-like value (tool inputs are objects), walking strings recursively. */
export function redactValue(value: unknown, opts: RedactOptions): { value: unknown; count: number } {
  if (typeof value === "string") {
    const r = redactText(value, opts);
    return { value: r.text, count: r.count };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const out = value.map((v) => {
      const r = redactValue(v, opts);
      count += r.count;
      return r.value;
    });
    return { value: out, count };
  }
  if (value && typeof value === "object") {
    let count = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = redactValue(v, opts);
      count += r.count;
      out[k] = r.value;
    }
    return { value: out, count };
  }
  return { value, count: 0 };
}

/** Returns a redacted copy of a session with `redactions` set to the number of replacements. */
export function redactSession(session: TraceSession, opts: RedactOptions): TraceSession {
  let total = 0;
  const sensitiveToolCallIds = new Set<string>();
  for (const e of session.events) {
    if (e.kind === "tool_call" && toolCallTargetsSensitiveFile(e.input)) {
      sensitiveToolCallIds.add(e.id);
    }
  }

  const events = session.events.map((e): TraceEvent => {
    if (e.kind === "tool_result" && sensitiveToolCallIds.has(e.id)) {
      total += 1;
      return { ...e, output: "[REDACTED:sensitive-file]" };
    }
    const r = redactValue(e, opts);
    total += r.count;
    return r.value as TraceEvent;
  });

  let cwd: string | undefined;
  if (session.cwd) {
    const r = redactText(session.cwd, opts);
    cwd = r.text;
    total += r.count;
  }

  let gitBranch: string | undefined;
  if (session.gitBranch) {
    const r = redactText(session.gitBranch, opts);
    gitBranch = r.text;
    total += r.count;
  }

  let labels = session.labels;
  if (session.labels.commits) {
    const commits = session.labels.commits.map((c) => {
      const r = redactText(c.subject, opts);
      total += r.count;
      return { ...c, subject: r.text };
    });
    labels = { ...session.labels, commits };
  }

  return { ...session, cwd, gitBranch, labels, events, redactions: total };
}
