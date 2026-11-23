/**
 * Generates a fresh friend intake token (`tv_<64-hex>`), prints its SHA-256 entry
 * for TRACEVAULT_TOKENS_JSON, and outputs the friend's onboarding command without
 * storing secrets anywhere in the repository.
 */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { hashToken } from "./server";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "allow-raw": { type: "boolean" },
    "max-bytes": { type: "string" },
    "intake-url": { type: "string" },
  },
});

const contributor = positionals[0];
if (!contributor || !/^[a-z0-9][a-z0-9_-]{1,62}$/i.test(contributor)) {
  console.error("Usage: node dist/intake/tokenGen.js <contributor-id> [--allow-raw] [--max-bytes N] [--intake-url URL]");
  process.exit(1);
}

const token = `tv_${randomBytes(32).toString("hex")}`;
const entry = {
  [hashToken(token)]: {
    contributor,
    allowRaw: Boolean(values["allow-raw"]),
    ...(values["max-bytes"] ? { maxBytes: Number(values["max-bytes"]) } : {}),
  },
};

const intakeUrl = values["intake-url"] ?? "https://YOUR-INTAKE-SERVICE.run.app";
console.log("1. Merge this entry into TRACEVAULT_TOKENS_JSON on the intake server:\n");
console.log(JSON.stringify(entry, null, 2));
console.log("\n2. Send this one-time setup command privately to your friend (with `exclude` / `deny` customized):\n");
console.log(
  `tracevault init --intake ${intakeUrl} --token ${token} --exclude /work --deny "${contributor}"`,
);
