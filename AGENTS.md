# AGENTS — tracevault

Node.js (>=22.15) TypeScript CLI + zero-dependency intake server that collects coding-agent session logs (`src/adapters/`), redacts secrets/PII (`src/redact.ts`), optionally encrypts the raw tier locally with AES-256-GCM (`src/crypto.ts`), and syncs archives (`src/storage/`, `src/sync.ts`) to GCS / S3-compatible / local storage / token-scoped `--intake`.

## Structure

- `src/adapters/` — agent parsers (Claude Code, Codex, Gemini CLI, OpenCode, Claude Desktop) + `rawFiles.ts`
- `src/redact.ts`, `src/crypto.ts`, `src/sync.ts`, `src/export.ts`, `src/doctor.ts`, `src/schedule.ts`
- `src/storage/` — GCS (`gcs.ts`), S3/R2/Contabo (`s3.ts`), local (`local.ts`), write-only contributor intake (`intake.ts`)
- `src/intake/` — Cloud Run / HTTP friend intake server (`server.ts`, `gcsSigner.ts`, `cli.ts`, `tokenGen.ts`)
- `intake/` — container deployment (`Dockerfile`, `README.md`)
- `docs/FRIENDS_GUIDE.md` — contributor safety checklist & onboarding
- `test/` — Jest unit & end-to-end tests (`redact.test.ts`, `intake.test.ts`, `parsers.test.ts`, `crypto.test.ts`, `sync.test.ts`, `sqlite.test.ts`)

## Commands

- Install deps: `npm ci`
- Typecheck: `npm run typecheck`
- Tests: `npm test`
- Build: `npm run build`
- Read-only session scan: `node --no-warnings dist/cli.js scan`
- Sync preview (no upload): `node --no-warnings dist/cli.js sync --dry-run`
- Generate friend intake token: `node dist/intake/tokenGen.js <contributor-id>`

## Critical Rules

- **Never read, log, print, or commit `~/.tracevault/raw.key`**, `~/.tracevault/intake.token`, `TRACEVAULT_TOKENS_JSON`, or cloud credentials (`AWS_*`, `GOOGLE_*`).
- **Keep `node_modules/` and `dist/` intact in the active checkout** when scheduled sync (`launchd` / `systemd`) executes `dist/cli.js sync` nightly.
- Always run `npm test` (including `test/redact.test.ts` and `test/intake.test.ts`) after modifying adapters, redaction rules, intake server, or storage sync.
