import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressTrace, decompressTrace, loadOrCreateKey, openRaw, sealRaw } from "../src/crypto";

describe("raw tier encryption", () => {
  const dir = mkdtempSync(join(tmpdir(), "tv-crypto-"));
  const keyFile = join(dir, "raw.key");

  it("creates a key readable only by the owner and reloads the same key", () => {
    const k1 = loadOrCreateKey(keyFile);
    expect(k1).toHaveLength(32);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(loadOrCreateKey(keyFile).equals(k1)).toBe(true);
  });

  it("round-trips data and never stores plaintext", () => {
    const key = loadOrCreateKey(keyFile);
    const plain = Buffer.from('{"secret":"OPENAI_API_KEY=sk-test"}\n'.repeat(100));
    const sealed = sealRaw(plain, key);
    expect(sealed.includes(Buffer.from("OPENAI_API_KEY"))).toBe(false);
    expect(openRaw(sealed, key).equals(plain)).toBe(true);
  });

  it("rejects data decrypted with the wrong key", () => {
    const sealed = sealRaw(Buffer.from("hello"), loadOrCreateKey(keyFile));
    const wrong = Buffer.alloc(32, 7);
    expect(() => openRaw(sealed, wrong)).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    const key = loadOrCreateKey(keyFile);
    const sealed = sealRaw(Buffer.from("hello world"), key);
    sealed[sealed.length - 1] = sealed[sealed.length - 1]! ^ 0xff;
    expect(() => openRaw(sealed, key)).toThrow();
  });

  it("compresses traces losslessly", () => {
    expect(decompressTrace(compressTrace("héllo ✓"))).toBe("héllo ✓");
  });
});
