/**
 * Outcome labels from git history.
 *
 * Whether a session's work ended up committed is the cheapest strong signal of quality
 * available: it needs no human labelling and separates sessions that helped from
 * sessions that were abandoned. Commits are attributed to a session when they land in
 * its repo between its start and two hours after its last event.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { TraceSession } from "./types";

const GRACE_MS = 2 * 60 * 60 * 1000;

/** Returns commits in `cwd`'s repo inside the session's time window, or undefined when unavailable. */
export function commitsDuring(session: TraceSession): TraceSession["labels"]["commits"] {
  if (!session.cwd || !session.startedAt || !session.endedAt || !existsSync(session.cwd)) return undefined;
  const since = new Date(session.startedAt).toISOString();
  const until = new Date(new Date(session.endedAt).getTime() + GRACE_MS).toISOString();
  try {
    const out = execFileSync("git", ["-C", session.cwd, "log", "--all", `--since=${since}`, `--until=${until}`, "--format=%H%x09%cI%x09%s"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha = "", ts = "", ...subject] = line.split("\t");
        return { sha, ts, subject: subject.join("\t") };
      });
  } catch {
    return undefined; // not a git repo, or git missing
  }
}
