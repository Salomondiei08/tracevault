/**
 * End-to-end sync against a fake home directory and a local storage folder,
 * so the test never reads the real machine's sessions or touches the network.
 */
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "tv-sync-"));
process.env.TRACEVAULT_HOME = join(root, "app");

// Imported after TRACEVAULT_HOME is set so state and key paths point into the temp dir.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sync } = require("../src/sync") as typeof import("../src/sync");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { LocalStorage } = require("../src/storage/local") as typeof import("../src/storage/local");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { decompressTrace, openRaw, loadOrCreateKey } = require("../src/crypto") as typeof import("../src/crypto");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { keyPath } = require("../src/config") as typeof import("../src/config");
import type { Config, State } from "../src/config";

const home = join(root, "home");
const sessionId = "11111111-2222-3333-4444-555555555555";
const sessionFile = join(home, ".claude", "projects", "-repo", `${sessionId}.jsonl`);
const lines = [
  { type: "user", sessionId, cwd: join(home, "repo"), timestamp: "2026-11-01T10:00:00Z", message: { role: "user", content: "deploy with STRIPE_SECRET_KEY=" + "sk" + "_live_abcdefghijklmnop1234" } },
  { type: "assistant", sessionId, timestamp: "2026-11-01T10:00:02Z", message: { role: "assistant", model: "m", content: [{ type: "text", text: "Done." }] } },
];
mkdirSync(join(home, ".claude", "projects", "-repo"), { recursive: true });
writeFileSync(sessionFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
// Make the session look finished (older than the idle window).
const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
utimesSync(sessionFile, old, old);

const storageDir = join(root, "bucket");
const cfg: Config = {
  storage: { type: "local", dir: storageDir },
  contributor: "tester",
  idleMinutes: 30,
  excludePaths: [],
  denylist: [],
  uploadRaw: true,
};

describe("sync", () => {
  const state: State = {};

  it("uploads a redacted trace and an encrypted raw copy", async () => {
    const storage = new LocalStorage(storageDir);
    const r = await sync(cfg, storage, state, { home, agents: ["claude-code"] });
    expect(r).toMatchObject({ uploaded: 1, sessions: 1, failed: [] });

    const trace = decompressTrace(readFileSync(join(storageDir, "contributors/tester/traces/claude-code", `${sessionId}.json.gz`)));
    expect(trace).not.toContain("sk" + "_live_");
    expect(trace).not.toContain(home);
    expect(JSON.parse(trace).cwd).toBe("~/repo");

    const rawPath = join(storageDir, "contributors/tester/raw/claude-code", `.claude/-repo/${sessionId}.jsonl.zst.enc`);
    const sealed = readFileSync(rawPath);
    expect(sealed.includes(Buffer.from("sk" + "_live_"))).toBe(false);
    expect(openRaw(sealed, loadOrCreateKey(keyPath())).toString()).toContain("sk" + "_live_abcdefghijklmnop1234");
  });

  it("skips unchanged sessions on the next run", async () => {
    const r = await sync(cfg, new LocalStorage(storageDir), state, { home, agents: ["claude-code"] });
    expect(r).toMatchObject({ uploaded: 0, unchanged: 1 });
  });

  it("waits for sessions that are still being written", async () => {
    writeFileSync(sessionFile, readFileSync(sessionFile, "utf8") + JSON.stringify(lines[1]) + "\n");
    const r = await sync(cfg, new LocalStorage(storageDir), state, { home, agents: ["claude-code"] });
    expect(r).toMatchObject({ uploaded: 0, active: 1 });
  });

  it("honours excluded paths", async () => {
    const r = await sync({ ...cfg, excludePaths: ["/repo"] }, new LocalStorage(storageDir), {}, { home, agents: ["claude-code"], includeActive: true });
    expect(r).toMatchObject({ uploaded: 0, excluded: 1 });
  });
});
