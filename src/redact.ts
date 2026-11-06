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
    /^(true|false|null|undefined|none|string|number|boolean|required|optional|redacted|changeme|xxxxxx+|\*+)$/i.test(value)
  );
}

/** Well-known token shapes. Order matters: specific provider formats run before generic ones. */
export const RULES: Rule[] = [
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "anthropic", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai", pattern: /sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
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
];

/** Values that look like secrets by randomness alone: long, mixed-character, high entropy. */
const HIGH_ENTROPY_CANDIDATE = /\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g;

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
  let text = opts.home ? input.split(opts.home).join("~") : input;
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

  text = text.replace(HIGH_ENTROPY_CANDIDATE, (m) => {
    if (looksLikeHarmlessId(m) || m.includes("REDACTED") || entropy(m) < 4.3) return m;
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
  const events = session.events.map((e): TraceEvent => {
    const r = redactValue(e, opts);
    total += r.count;
    return r.value as TraceEvent;
  });
  const cwd = session.cwd ? redactText(session.cwd, opts).text : undefined;
  return { ...session, cwd, events, redactions: total };
}
