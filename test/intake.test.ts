/**
 * Hermetic end-to-end tests for token-scoped friend intake uploads and GCS V4 URL signing.
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "tv-intake-"));
process.env.TRACEVAULT_HOME = join(root, "app");

// Imported after TRACEVAULT_HOME is set so state and token paths point into the temp dir.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sync } = require("../src/sync") as typeof import("../src/sync");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { decompressTrace } = require("../src/crypto") as typeof import("../src/crypto");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { IntakeStorage, intakeWhoami } = require("../src/storage/intake") as typeof import("../src/storage/intake");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createIntakeServer, hashToken } = require("../src/intake/server") as typeof import("../src/intake/server");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createPemSigner, signGcsV4PutUrl } = require("../src/intake/gcsSigner") as typeof import("../src/intake/gcsSigner");
import type { Config } from "../src/config";

const home = join(root, "home");
const bucketDir = join(root, "bucket");
const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const sessionFile = join(home, ".claude", "projects", "-repo", `${sessionId}.jsonl`);
mkdirSync(join(home, ".claude", "projects", "-repo"), { recursive: true });
writeFileSync(
  sessionFile,
  [
    {
      type: "user",
      sessionId,
      cwd: join(home, "personal-app"),
      timestamp: "2026-11-20T10:00:00Z",
      message: { role: "user", content: "check OPENROUTER_API_KEY=" + "sk" + "-or-v1-0123456789abcdef0123456789abcdef01234567" },
    },
    {
      type: "assistant",
      sessionId,
      timestamp: "2026-11-20T10:00:05Z",
      message: { role: "assistant", model: "m", content: [{ type: "text", text: "Checked." }] },
    },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n") + "\n",
);
const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
utimesSync(sessionFile, old, old);

const FRIEND_TOKEN = "tv_test_friend_alex_token_0123456789abcdef";

describe("intake server & storage", () => {
  const server = createIntakeServer({
    localDir: bucketDir,
    defaultMaxBytes: 1024 * 1024,
    tokens: {
      [hashToken(FRIEND_TOKEN)]: { contributor: "friend-alex", allowRaw: false },
    },
  });
  let baseUrl = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("verifies contributor identity and enforces token-bound upload prefix during sync", async () => {
    const info = await intakeWhoami(baseUrl, FRIEND_TOKEN);
    expect(info).toEqual({ contributor: "friend-alex", allowRaw: false, maxBytes: 1024 * 1024 });

    // Even if a client claims contributor="salomon", the server locks writes to contributors/friend-alex/.
    const cfg: Config = {
      storage: { type: "intake", url: baseUrl },
      contributor: "salomon",
      idleMinutes: 30,
      excludePaths: [],
      denylist: [],
      uploadRaw: false,
    };
    const storage = new IntakeStorage(baseUrl, FRIEND_TOKEN);
    const report = await sync(cfg, storage, {}, { home, agents: ["claude-code"] });
    expect(report).toMatchObject({ uploaded: 1, sessions: 1, failed: [] });

    const uploadedTrace = join(bucketDir, "contributors/friend-alex/traces/claude-code", `${sessionId}.json.gz`);
    expect(existsSync(uploadedTrace)).toBe(true);
    expect(existsSync(join(bucketDir, "contributors/friend-alex/manifest.json"))).toBe(true);
    expect(existsSync(join(bucketDir, "contributors/salomon/manifest.json"))).toBe(false);

    const parsed = JSON.parse(decompressTrace(readFileSync(uploadedTrace)));
    expect(JSON.stringify(parsed)).not.toContain("sk" + "-or-v1-");
    expect(parsed.cwd).toBe("~/personal-app");
  });

  it("rejects invalid tokens, path traversal, raw uploads when disabled, and oversized files", async () => {
    const badStorage = new IntakeStorage(baseUrl, "tv_invalid_token");
    await expect(badStorage.put("manifest.json", Buffer.from("{}"), "application/json")).rejects.toThrow("401");

    const storage = new IntakeStorage(baseUrl, FRIEND_TOKEN);
    await expect(storage.put("traces/claude-code/../../etc/passwd.json.gz", Buffer.from("x"), "application/gzip")).rejects.toThrow("403");
    await expect(storage.put("raw/claude-code/test.jsonl.zst.enc", Buffer.from("x"), "application/octet-stream")).rejects.toThrow("403");
    await expect(storage.put("manifest.json", Buffer.alloc(1024 * 1024 + 10), "application/json")).rejects.toThrow("413");
  });

  it("keeps IntakeStorage strictly write-only for get and list", async () => {
    const storage = new IntakeStorage(baseUrl, FRIEND_TOKEN);
    await expect(storage.get("manifest.json")).rejects.toThrow(/write-only/i);
    await expect(storage.list("contributors/")).rejects.toThrow(/write-only/i);
  });

  it("generates valid GCS V4 signed PUT URLs with pure-Node crypto", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const res = await signGcsV4PutUrl({
      bucket: "example-agent-traces",
      objectName: "contributors/friend-alex/traces/claude-code/s1.json.gz",
      contentType: "application/gzip",
      contentLength: 123,
      signerEmail: "tracevault-intake@example-project.iam.gserviceaccount.com",
      signBytes: createPemSigner(pem),
      now: new Date("2026-11-23T00:00:00Z"),
    });
    const parsed = new URL(res.uploadUrl);
    expect(parsed.origin).toBe("https://storage.googleapis.com");
    expect(parsed.pathname).toBe("/example-agent-traces/contributors/friend-alex/traces/claude-code/s1.json.gz");
    expect(parsed.searchParams.get("X-Goog-Algorithm")).toBe("GOOG4-RSA-SHA256");
    expect(parsed.searchParams.get("X-Goog-SignedHeaders")).toBe("content-type;host");
    expect(parsed.searchParams.get("X-Goog-Date")).toBe("20261123T000000Z");
    expect(parsed.searchParams.get("X-Goog-Signature")).toMatch(/^[a-f0-9]{512}$/);
    expect(res.headers).toEqual({ "Content-Type": "application/gzip" });
  });
});
