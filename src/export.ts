/**
 * Turns stored traces into fine-tuning datasets.
 *
 * `sft` writes OpenAI-style chat JSONL with tool calls, a format most trainers
 * (OpenAI fine-tuning, Hugging Face TRL, Axolotl, Unsloth) read directly:
 *   {"messages":[{"role":"user",...},{"role":"assistant","tool_calls":[...]},{"role":"tool",...}], "meta": {...}}
 */
import type { TraceSession } from "./types";

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface ExportFilter {
  /** Drop sessions with fewer user turns than this. */
  minUserTurns?: number;
  /** Keep only sessions whose repo got a commit during or right after the session. */
  committedOnly?: boolean;
  /** Keep only these agents. */
  agents?: string[];
}

/** Applies the export filter to one session. */
export function keepSession(s: TraceSession, f: ExportFilter): boolean {
  if (f.agents?.length && !f.agents.includes(s.agent)) return false;
  const userTurns = s.events.filter((e) => e.kind === "user").length;
  if (userTurns < (f.minUserTurns ?? 1)) return false;
  if (f.committedOnly && !(s.labels.commits?.length ?? 0)) return false;
  return true;
}

/**
 * Converts a session into chat messages. Tool calls attach to the assistant message
 * before them; reasoning and injected system context are left out, because they
 * either cannot be reproduced at inference time or were not written by the human.
 */
export function toChatMessages(s: TraceSession): ChatMessage[] {
  const out: ChatMessage[] = [];
  const lastAssistant = (): ChatMessage => {
    const last = out[out.length - 1];
    if (last?.role === "assistant") return last;
    const m: ChatMessage = { role: "assistant", content: "" };
    out.push(m);
    return m;
  };

  for (const e of s.events) {
    switch (e.kind) {
      case "user": {
        const last = out[out.length - 1];
        // Consecutive user blocks (text + pasted content) belong to one turn.
        if (last?.role === "user") last.content += `\n\n${e.text}`;
        else out.push({ role: "user", content: e.text });
        break;
      }
      case "assistant": {
        const m = lastAssistant();
        // Text that follows a tool call starts a new assistant message.
        if (m.tool_calls?.length) out.push({ role: "assistant", content: e.text });
        else m.content = m.content ? `${m.content}\n\n${e.text}` : e.text;
        break;
      }
      case "tool_call": {
        const m = lastAssistant();
        (m.tool_calls ??= []).push({
          id: e.id,
          type: "function",
          function: { name: e.name, arguments: typeof e.input === "string" ? e.input : JSON.stringify(e.input ?? {}) },
        });
        break;
      }
      case "tool_result":
        out.push({ role: "tool", tool_call_id: e.id, content: e.output });
        break;
      default:
        break;
    }
  }
  // A trailing user message has no answer to learn from.
  while (out.length && out[out.length - 1]!.role === "user") out.pop();
  return out;
}

/** One JSONL line for an SFT dataset, or undefined when the session has nothing to learn from. */
export function toSftLine(s: TraceSession): string | undefined {
  const messages = toChatMessages(s);
  if (!messages.some((m) => m.role === "assistant")) return undefined;
  const meta = {
    agent: s.agent,
    sessionId: s.sessionId,
    models: s.models,
    startedAt: s.startedAt,
    commits: s.labels.commits?.length ?? 0,
    userInterrupts: s.labels.userInterrupts ?? 0,
  };
  return JSON.stringify({ messages, meta });
}
