/**
 * Compression and client-side encryption for the raw tier.
 *
 * Raw files are archived unredacted (so a buggy adapter never costs data), which
 * means they hold secrets. They are therefore encrypted on this machine with a key
 * that never leaves it: the storage provider only ever sees ciphertext.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { zstdCompressSync, zstdDecompressSync, gzipSync, gunzipSync } from "node:zlib";

/** File header so future versions can change the scheme without guessing. */
const MAGIC = Buffer.from("TVR1");
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Loads the 32-byte raw-tier key, creating it (readable only by this user) on first use. */
export function loadOrCreateKey(keyPath: string): Buffer {
  if (existsSync(keyPath)) {
    const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error(`Key at ${keyPath} is not a 32-byte base64 key`);
    return key;
  }
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString("base64") + "\n", { mode: 0o600 });
  return key;
}

/** zstd-compresses then AES-256-GCM encrypts. Output: MAGIC | iv | tag | ciphertext. */
export function sealRaw(plain: Buffer, key: Buffer): Buffer {
  const compressed = zstdCompressSync(plain);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

/** Reverses `sealRaw`; throws if the data was tampered with or the key is wrong. */
export function openRaw(sealed: Buffer, key: Buffer): Buffer {
  if (!sealed.subarray(0, 4).equals(MAGIC)) throw new Error("Not a tracevault raw object");
  const iv = sealed.subarray(4, 4 + IV_BYTES);
  const tag = sealed.subarray(4 + IV_BYTES, 4 + IV_BYTES + TAG_BYTES);
  const body = sealed.subarray(4 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return zstdDecompressSync(Buffer.concat([decipher.update(body), decipher.final()]));
}

/** Normalized traces are already redacted, so they are only compressed (gzip, for easy reading by any tool). */
export const compressTrace = (text: string): Buffer => gzipSync(Buffer.from(text, "utf8"));
export const decompressTrace = (buf: Buffer): string => gunzipSync(buf).toString("utf8");
