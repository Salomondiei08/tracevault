import { parseClaudeRecords } from "../src/adapters/claudeCode";
import { isInjectedContext, parseCodexRecords } from "../src/adapters/codex";
import { parseGeminiChat } from "../src/adapters/geminiCli";
import { toChatMessages, toSftLine } from "../src/export";

/** Minimal records in the shape Claude Code writes them. */
const claudeRecords = [
  { type: "permission-mode", permissionMode: "default" },
  {
    type: "user",
    sessionId: "abc",
    cwd: "/repo",
    gitBranch: "main",
    version: "2.1.0",
    timestamp: "2026-11-01T10:00:00Z",
    message: { role: "user", content: "fix the failing test" },
  },
  {
    type: "assistant",
    sessionId: "abc",
    timestamp: "2026-11-01T10:00:05Z",
    message: { model: "claude-test", role: "assistant", content: [{ type: "thinking", thinking: "", signature: "x" }] },
  },
  {
    type: "assistant",
    sessionId: "abc",
    timestamp: "2026-11-01T10:00:06Z",
    message: {
      model: "claude-test",
      role: "assistant",
      content: [
        { type: "text", text: "Running the tests." },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
      ],
    },
  },
  {
    type: "user",
    sessionId: "abc",
    timestamp: "2026-11-01T10:00:09Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "1 failing" }], is_error: true }] },
  },
  {
    type: "user",
    sessionId: "abc",
    timestamp: "2026-11-01T10:00:10Z",
    message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
  },
];

describe("Claude Code parser", () => {
  const s = parseClaudeRecords(claudeRecords, "fallback");

  it("reads session metadata", () => {
    expect(s).toMatchObject({ agent: "claude-code", sessionId: "abc", cwd: "/repo", gitBranch: "main", agentVersion: "2.1.0", models: ["claude-test"] });
    expect(s.startedAt).toBe("2026-11-01T10:00:00Z");
    expect(s.endedAt).toBe("2026-11-01T10:00:10Z");
  });

  it("keeps text, tool calls and results in order and drops empty thinking", () => {
    expect(s.events.map((e) => e.kind)).toEqual(["user", "assistant", "tool_call", "tool_result", "user"]);
    expect(s.events[3]).toMatchObject({ kind: "tool_result", id: "t1", output: "1 failing", isError: true });
  });

  it("counts user interrupts as a quality signal", () => {
    expect(s.labels.userInterrupts).toBe(1);
  });
});

describe("Codex parser", () => {
  const records = [
    { type: "session_meta", timestamp: "2026-11-05T08:00:00Z", payload: { session_id: "cx1", cwd: "/w", cli_version: "1.0" } },
    { type: "turn_context", timestamp: "2026-11-05T08:00:01Z", payload: { model: "gpt-test", cwd: "/w" } },
    { type: "response_item", timestamp: "2026-11-05T08:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n..." }] } },
    { type: "response_item", timestamp: "2026-11-05T08:00:02Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] } },
    { type: "response_item", timestamp: "2026-11-05T08:00:03Z", payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}', call_id: "c1" } },
    { type: "response_item", timestamp: "2026-11-05T08:00:04Z", payload: { type: "function_call_output", call_id: "c1", output: "a.ts\nb.ts" } },
    { type: "response_item", timestamp: "2026-11-05T08:00:05Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Two files." }] } },
    { type: "event_msg", timestamp: "2026-11-05T08:00:06Z", payload: { type: "turn_aborted" } },
  ];
  const s = parseCodexRecords(records, "fallback");

  it("separates injected instructions from what the human typed", () => {
    expect(s.events[0]).toMatchObject({ kind: "system" });
    expect(s.events[1]).toEqual({ kind: "user", ts: "2026-11-05T08:00:02Z", text: "list files" });
    expect(isInjectedContext("<environment_context>cwd</environment_context>")).toBe(true);
    expect(isInjectedContext("please fix <div> layout")).toBe(false);
  });

  it("parses tool arguments and results", () => {
    expect(s.events[2]).toMatchObject({ kind: "tool_call", id: "c1", name: "exec_command", input: { cmd: "ls" } });
    expect(s.events[3]).toMatchObject({ kind: "tool_result", id: "c1", output: "a.ts\nb.ts" });
  });

  it("reads metadata and aborted turns", () => {
    expect(s).toMatchObject({ sessionId: "cx1", cwd: "/w", models: ["gpt-test"], agentVersion: "1.0" });
    expect(s.labels.userInterrupts).toBe(1);
  });
});

describe("Gemini CLI parser", () => {
  it("expands tool calls with their results", () => {
    const s = parseGeminiChat(
      {
        sessionId: "g1",
        startTime: "2026-01-01T00:00:00Z",
        messages: [
          { type: "user", content: "read README" },
          {
            type: "gemini",
            model: "gemini-test",
            content: "Here it is.",
            toolCalls: [{ id: "r1", name: "read_file", args: { path: "README.md" }, result: "# Hello", status: "success" }],
          },
        ],
      },
      "fallback",
    );
    expect(s.events.map((e) => e.kind)).toEqual(["user", "assistant", "tool_call", "tool_result"]);
    expect(s.models).toEqual(["gemini-test"]);
  });
});

describe("SFT export", () => {
  const s = parseClaudeRecords(claudeRecords, "fallback");

  it("produces OpenAI-style chat messages with tool calls attached to the assistant", () => {
    const m = toChatMessages(s);
    expect(m[0]).toEqual({ role: "user", content: "fix the failing test" });
    expect(m[1]).toMatchObject({ role: "assistant", content: "Running the tests." });
    expect(m[1]!.tool_calls![0]).toEqual({ id: "t1", type: "function", function: { name: "Bash", arguments: '{"command":"npm test"}' } });
    expect(m[2]).toEqual({ role: "tool", tool_call_id: "t1", content: "1 failing" });
  });

  it("drops a trailing user message that has no answer", () => {
    const m = toChatMessages(s);
    expect(m[m.length - 1]!.role).not.toBe("user");
  });

  it("includes quality metadata in each line", () => {
    const line = JSON.parse(toSftLine(s)!);
    expect(line.meta).toMatchObject({ agent: "claude-code", sessionId: "abc", userInterrupts: 1 });
  });
});

describe("Claude subagent transcripts", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { withSubagentId } = require("../src/adapters/claudeCode") as typeof import("../src/adapters/claudeCode");
  const s = parseClaudeRecords(claudeRecords, "fallback");

  it("get their own id so they do not overwrite the parent session", () => {
    expect(withSubagentId(s, "/p/abc/subagents/agent-a1b2.jsonl").sessionId).toBe("abc/agent-a1b2");
    expect(withSubagentId(s, "/p/abc.jsonl").sessionId).toBe("abc");
  });
});
