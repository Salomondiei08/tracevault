/**
 * Health checks, most importantly: agents that silently delete history.
 * Claude Code removes transcripts older than `cleanupPeriodDays` (default 30), which is
 * the single biggest cause of lost training data.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigDirs } from "./adapters/claudeCode";

export interface DoctorFinding {
  ok: boolean;
  message: string;
  fix?: () => void;
}

/** A retention period long enough to mean "keep forever" in practice (about 270 years). */
export const KEEP_FOREVER_DAYS = 100_000;

export function checkClaudeRetention(home: string): DoctorFinding[] {
  return claudeConfigDirs(home).map((dir): DoctorFinding => {
    const settings = join(dir, "settings.json");
    let parsed: Record<string, unknown> = {};
    if (existsSync(settings)) {
      try {
        parsed = JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>;
      } catch {
        return { ok: false, message: `${settings} is not valid JSON; check cleanupPeriodDays by hand` };
      }
    }
    const days = typeof parsed.cleanupPeriodDays === "number" ? parsed.cleanupPeriodDays : 30;
    if (days >= 3650) return { ok: true, message: `${dir}: transcripts kept for ${days} days` };
    return {
      ok: false,
      message: `${dir}: Claude Code deletes transcripts after ${days} days`,
      fix: () => writeFileSync(settings, JSON.stringify({ ...parsed, cleanupPeriodDays: KEEP_FOREVER_DAYS }, null, 2) + "\n"),
    };
  });
}
