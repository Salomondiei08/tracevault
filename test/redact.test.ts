import { entropy, redactSession, redactText } from "../src/redact";
import type { TraceSession } from "../src/types";

describe("redactText", () => {
  it.each([
    ["Anthropic key", "key is sk" + "-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", "sk" + "-ant-api03"],
    ["AWS access key", "aws_access_key_id = AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
    ["GitHub token", "token gh" + "p_abcdefghijklmnopqrstuvwxyz0123456789AB", "gh" + "p_abcdef"],
    ["Google API key", "AI" + "zaSyA1234567890abcdefghijklmnopqrstuv", "AI" + "zaSyA1234"],
    ["Stripe live key", "sk" + "_live_51Habcdefghijklmnop", "sk" + "_live_51H"],
    ["database URL password", "postgres://admin:hunter2secret@db.example.com:5432/app", "hunter2secret"],
    ["env assignment", "WAVE_API_SECRET=wave_sn_prod_8f7a6b5c4d3e", "wave_sn_prod_8f7a6b5c4d3e"],
    ["JSON secret field", '{"client_secret": "Zm9vYmFyYmF6cXV4MTIzNDU2"}', "Zm9vYmFyYmF6cXV4MTIzNDU2"],
    ["email", "contact me at someone@example.org", "someone@example.org"],
    ["phone", "call +225 07 12 34 56 78 today", "+225 07 12 34 56 78"],
    ["private key", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----", "abc"],
  ])("removes a %s", (_name, input, secret) => {
    const r = redactText(input);
    expect(r.text).not.toContain(secret);
    expect(r.count).toBeGreaterThan(0);
  });

  it("keeps git SHAs and UUIDs, which are meaningful and not secret", () => {
    const input = "commit 168a06e3f2b1c4d5e6f708192a3b4c5d6e7f8091 session b434f723-81dd-4275-8cc5-c776f45bbfcd";
    expect(redactText(input).text).toBe(input);
  });

  it("keeps ordinary code untouched", () => {
    const code = "const password = form.get('password');\nfunction getUserById(id: string) { return db.users.find(id); }";
    expect(redactText(code).count).toBe(0);
  });

  it("replaces the home directory so usernames do not leak", () => {
    expect(redactText("/Users/alice/Projects/app/src/index.ts", { home: "/Users/alice" }).text).toBe("~/Projects/app/src/index.ts");
  });

  it("removes denylisted words case-insensitively", () => {
    expect(redactText("Built for ACME Corp by acme corp", { denylist: ["Acme Corp"] }).text).toBe(
      "Built for [REDACTED:denylist] by [REDACTED:denylist]",
    );
  });

  it("measures entropy so random tokens can be told apart from words", () => {
    expect(entropy("aaaaaaaa")).toBe(0);
    expect(entropy("q8Zr2LmX9vPw4KtB")).toBeGreaterThan(3.5);
  });
});

describe("redactSession", () => {
  it("redacts inside tool inputs and outputs and counts every replacement", () => {
    const session: TraceSession = {
      formatVersion: 1,
      agent: "test",
      sessionId: "s1",
      cwd: "/Users/alice/app",
      models: [],
      labels: {},
      redactions: 0,
      events: [
        { kind: "tool_call", id: "1", name: "Bash", input: { command: "export OPENAI_API_KEY=" + "sk" + "-proj-abcdefghijklmnopqrstuvwx" } },
        { kind: "tool_result", id: "1", output: "GITHUB_TOKEN=" + "gh" + "p_abcdefghijklmnopqrstuvwxyz0123456789AB" },
      ],
    };
    const clean = redactSession(session, { home: "/Users/alice" });
    const text = JSON.stringify(clean);
    expect(text).not.toContain("sk" + "-proj-abcdef");
    expect(text).not.toContain("gh" + "p_abcdef");
    expect(clean.cwd).toBe("~/app");
    expect(clean.redactions).toBeGreaterThanOrEqual(2);
  });
});
