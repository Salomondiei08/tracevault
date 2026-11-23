import { entropy, isSensitiveFilePath, redactSession, redactText } from "../src/redact";
import type { TraceSession } from "../src/types";

describe("redactText", () => {
  it.each([
    ["Anthropic key", "key is sk" + "-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", "sk" + "-ant-api03"],
    ["OpenRouter key", "key sk" + "-or-v1-0123456789abcdef0123456789abcdef0123", "sk" + "-or-v1-"],
    ["AWS access key", "aws_access_key_id = AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
    ["GitHub token", "token gh" + "p_abcdefghijklmnopqrstuvwxyz0123456789AB", "gh" + "p_abcdef"],
    ["Google API key", "AI" + "zaSyA1234567890abcdefghijklmnopqrstuv", "AI" + "zaSyA1234"],
    ["Supabase token", "sbp_" + "0123456789abcdef0123456789abcdef01234567", "sbp_" + "012345"],
    ["Resend key", "re_" + "AbCdEfGhIjKlMnOpQrStUvWxYz123456", "re_" + "AbCdEf"],
    ["Vercel token", "vcp_" + "AbCdEfGhIjKlMnOpQrStUvWxYz123456", "vcp_" + "AbCdEf"],
    ["Telegram bot token", "123456789:" + "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ", "AAHdqTcvCH1vGWJxf"],
    ["Stripe live key", "sk" + "_live_51Habcdefghijklmnop", "sk" + "_live_51H"],
    ["database URL password", "postgres://admin:hunter2secret@db.example.com:5432/app", "hunter2secret"],
    ["env assignment", "WAVE_API_SECRET=wave_sn_prod_8f7a6b5c4d3e", "wave_sn_prod_8f7a6b5c4d3e"],
    ["JSON secret field", '{"client_secret": "Zm9vYmFyYmF6cXV4MTIzNDU2"}', "Zm9vYmFyYmF6cXV4MTIzNDU2"],
    ["email", "contact me at someone@example.org", "someone@example.org"],
    ["phone", "call +225 07 12 34 56 78 today", "+225 07 12 34 56 78"],
    ["private RFC1918 IP 10.x", "ssh root@10.0.1.5", "10.0.1.5"],
    ["private RFC1918 IP 192.168.x", "http://192.168.1.20:3000", "192.168.1.20"],
    ["private RFC1918 IP 172.16.x", "host 172.16.4.8", "172.16.4.8"],
    ["Tailscale CGNAT IP 100.x", "ssh user@100.64.12.34", "100.64.12.34"],
    ["private key", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----", "abc"],
  ])("removes a %s", (_name, input, secret) => {
    const r = redactText(input);
    expect(r.text).not.toContain(secret);
    expect(r.count).toBeGreaterThan(0);
  });

  it("keeps git SHAs, UUIDs, loopback IPs, and semver untouched", () => {
    const input = "commit 168a06e3f2b1c4d5e6f708192a3b4c5d6e7f8091 session b434f723-81dd-4275-8cc5-c776f45bbfcd http://127.0.0.1:3000 v10.8.0";
    expect(redactText(input).text).toBe(input);
  });

  it("keeps ordinary code untouched", () => {
    const code = "const password = form.get('password');\nfunction getUserById(id: string) { return db.users.find(id); }";
    expect(redactText(code).count).toBe(0);
  });

  it("replaces macOS, Windows, dash-encoded home paths, and user@host prompt prefixes", () => {
    expect(redactText("/Users/alice/Projects/app/src/index.ts", { home: "/Users/alice" }).text).toBe("~/Projects/app/src/index.ts");
    expect(redactText("C:\\Users\\alice\\repo and C:/Users/alice/repo and C:\\\\Users\\\\alice\\\\repo", { home: "C:\\Users\\alice" }).text).toBe(
      "~/repo and ~/repo and ~/repo",
    );
    expect(redactText("~/.claude/projects/-Users-alice-proj/s.jsonl", { home: "/Users/alice" }).text).toBe(
      "~/.claude/projects/~-proj/s.jsonl",
    );
    const prompt = redactText("alice@macbook:~/app$ ls", { home: "/Users/alice" });
    expect(prompt.text).toBe("~@[REDACTED:host]:~/app$ ls");
    expect(prompt.count).toBe(1);
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

describe("isSensitiveFilePath", () => {
  it("flags secret files while keeping example env files readable", () => {
    expect(isSensitiveFilePath("/Users/alice/app/.env.local")).toBe(true);
    expect(isSensitiveFilePath("~/.aws/credentials")).toBe(true);
    expect(isSensitiveFilePath("~/.ssh/id_ed25519")).toBe(true);
    expect(isSensitiveFilePath("~/.ssh/id_ed25519.pub")).toBe(false);
    expect(isSensitiveFilePath(".env.example")).toBe(false);
    expect(isSensitiveFilePath(".env.sample")).toBe(false);
    expect(isSensitiveFilePath(".env.template")).toBe(false);
  });
});

describe("redactSession", () => {
  it("redacts tool inputs/outputs, sensitive file reads, cwd, gitBranch, and commit labels", () => {
    const session: TraceSession = {
      formatVersion: 1,
      agent: "test",
      sessionId: "s1",
      cwd: "/Users/alice/app",
      gitBranch: "feat/acme-corp/alice@example.com",
      models: [],
      labels: {
        commits: [
          {
            sha: "168a06e3f2b1c4d5e6f708192a3b4c5d6e7f8091",
            subject: "fix: deploy /Users/alice/app with " + "sk" + "-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 for ACME Corp",
            ts: "2026-11-23T00:00:00Z",
          },
        ],
      },
      redactions: 0,
      events: [
        { kind: "tool_call", id: "1", name: "Bash", input: { command: "export OPENAI_API_KEY=" + "sk" + "-proj-abcdefghijklmnopqrstuvwx" } },
        { kind: "tool_result", id: "1", output: "GITHUB_TOKEN=" + "gh" + "p_abcdefghijklmnopqrstuvwxyz0123456789AB" },
        { kind: "tool_call", id: "2", name: "Read", input: { file_path: "/Users/alice/app/.env.local" } },
        { kind: "tool_result", id: "2", output: "UNSTRUCTURED_SECRET_VALUE=anything_here" },
        { kind: "tool_call", id: "3", name: "Bash", input: { command: "cat ~/.aws/credentials" } },
        { kind: "tool_result", id: "3", output: "[default]\naws_secret = raw" },
        { kind: "tool_call", id: "4", name: "Read", input: { file_path: "/Users/alice/app/.env.example" } },
        { kind: "tool_result", id: "4", output: "DATABASE_URL=postgres://user:pass@localhost:5432/app" },
      ],
    };
    const clean = redactSession(session, { home: "/Users/alice", denylist: ["ACME Corp", "acme-corp"] });
    const text = JSON.stringify(clean);
    expect(text).not.toContain("sk" + "-proj-abcdef");
    expect(text).not.toContain("gh" + "p_abcdef");
    expect(text).not.toContain("sk" + "-ant-api03");
    expect(text).not.toContain("UNSTRUCTURED_SECRET_VALUE");
    expect(text).not.toContain("aws_secret = raw");
    expect(text).not.toContain("ACME Corp");
    expect(text).not.toContain("alice@example.com");
    expect(clean.cwd).toBe("~/app");
    expect(clean.gitBranch).toBe("feat/[REDACTED:denylist]/[REDACTED:email]");
    expect(clean.labels.commits?.[0]?.sha).toBe("168a06e3f2b1c4d5e6f708192a3b4c5d6e7f8091");
    expect(clean.labels.commits?.[0]?.subject).not.toContain("/Users/alice");
    expect(clean.events.find((e) => e.kind === "tool_result" && e.id === "2")).toMatchObject({ output: "[REDACTED:sensitive-file]" });
    expect(clean.events.find((e) => e.kind === "tool_result" && e.id === "3")).toMatchObject({ output: "[REDACTED:sensitive-file]" });
    expect(clean.events.find((e) => e.kind === "tool_result" && e.id === "4")).toMatchObject({
      output: "DATABASE_URL=postgres://user:[REDACTED:url-credentials]@localhost:5432/app",
    });
    expect(clean.redactions).toBeGreaterThanOrEqual(8);
  });
});

describe("false positives found on real sessions", () => {
  it("keeps file paths, including encoded project folders", () => {
    const p = "/private/tmp/claude-501/-Users-user-Documents-Projects-aya/b434f723-81dd-4275-8cc5-c776f45bbfcd/scratchpad";
    expect(redactText(p).text).toBe(p);
    const q = "~/.claude/projects/-Users-user-Documents-Projects-aya-work-apps/session.jsonl";
    expect(redactText(q).text).toBe(q);
  });

  it("redacts the token in an Authorization header, not the scheme", () => {
    const t = "Authorization: Bearer " + "ya29" + "XyZabc123DEF456ghi789JKL";
    const r = redactText(t).text;
    expect(r).toContain("Bearer");
    expect(r).not.toContain("XyZabc123DEF456ghi789JKL");
  });

  it("keeps a shell variable passed as a bearer token", () => {
    expect(redactText('curl -H "Authorization: Bearer $T"').count).toBe(0);
  });

  it("still catches a random token without a known prefix", () => {
    expect(redactText("token q8Zr2LmX9vPw4KtB7nHs3JdF6gYc1WeA").text).toContain("[REDACTED");
  });
});
