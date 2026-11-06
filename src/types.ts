/**
 * The tracevault trace format: one shared shape for sessions from every coding agent.
 *
 * Every adapter converts its agent's native logs into `TraceSession`. Keeping this
 * format small and explicit is what lets exports (SFT, DPO, RL trajectories) be
 * written once instead of once per agent.
 */

/** Bumped whenever the shape below changes in a way readers must know about. */
export const TRACE_FORMAT_VERSION = 1;

/** One thing that happened in a session, in order. */
export type TraceEvent =
  | { kind: "user"; ts?: string; text: string }
  | { kind: "assistant"; ts?: string; text: string; model?: string }
  | { kind: "reasoning"; ts?: string; text: string }
  | { kind: "tool_call"; ts?: string; id: string; name: string; input: unknown }
  | { kind: "tool_result"; ts?: string; id: string; output: string; isError?: boolean }
  | { kind: "system"; ts?: string; text: string };

/** Signals about whether the session's work was kept, used later to filter or rank training data. */
export interface OutcomeLabels {
  /** Commits made in the session's repo between its start and shortly after its end. */
  commits?: { sha: string; subject: string; ts: string }[];
  /** How many times the user interrupted or rejected the agent. */
  userInterrupts?: number;
}

/** A whole session from one agent, normalized and (after redaction) safe to share. */
export interface TraceSession {
  formatVersion: number;
  /** Adapter id, e.g. "claude-code", "codex". */
  agent: string;
  /** The agent's own session id when it has one, otherwise a stable hash of the source path. */
  sessionId: string;
  /** Working directory the agent ran in, with the home directory replaced by "~". */
  cwd?: string;
  gitBranch?: string;
  agentVersion?: string;
  models: string[];
  startedAt?: string;
  endedAt?: string;
  events: TraceEvent[];
  labels: OutcomeLabels;
  /** How many secrets redaction replaced; kept so contributors can audit it. */
  redactions: number;
}

/** One file (or database extract) an adapter knows how to read. */
export interface SourceItem {
  /** Adapter id that owns this item. */
  agent: string;
  /** Stable key for this item across runs, used for the storage object name. */
  key: string;
  /** Absolute path on disk the item comes from. */
  path: string;
  /** Size in bytes and modification time, used for change detection and idle checks. */
  size: number;
  mtimeMs: number;
}

/** What every agent adapter provides. */
export interface Adapter {
  id: string;
  /** Human-readable name for scan output. */
  label: string;
  /** Lists every session item this adapter can find on this machine. */
  discover(home: string): Promise<SourceItem[]>;
  /**
   * Returns the bytes archived in the encrypted raw tier. Most adapters return the
   * file as-is; database-backed agents return a sanitized extract instead so that
   * login tokens stored beside the chats are never archived.
   */
  readRaw(item: SourceItem): Promise<Buffer>;
  /** Converts the item into normalized sessions, or returns [] when the adapter is raw-only. */
  parse(item: SourceItem): Promise<TraceSession[]>;
}
