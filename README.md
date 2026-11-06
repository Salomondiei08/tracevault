# tracevault

Collect your coding-agent sessions into a private, redacted, training-ready archive, so you can fine-tune a model on how you actually work.

Coding agents keep detailed logs of every session (prompts, tool calls, results, edits), and most of them quietly delete those logs after a few weeks. tracevault finds them, keeps them, removes secrets, and stores them in a bucket you own.

## What it collects

| Agent | Where it looks | Parsed into traces |
|---|---|---|
| Claude Code | `~/.claude*/projects`, `~/.claude-profiles/*/projects` | yes |
| Codex | `~/.codex/sessions`, `~/.codex/archived_sessions` | yes |
| Gemini CLI | `~/.gemini/tmp/*/chats` | yes |
| OpenCode | `~/.local/share/opencode/opencode.db` (chat tables only) | yes |
| Claude Desktop agent sessions | `~/Library/Application Support/Claude/local-agent-mode-sessions` | yes |
| Cursor | `state.vscdb` chat keys only | raw only |
| Antigravity, OpenHands, Cline, Pi | their session folders | raw only |

"Raw only" agents are archived now and can be parsed later from the archive, because waiting for a parser means losing history.

## How it works

Every session is stored in two tiers:

1. **Raw tier** (`raw/`): the original file, compressed with zstd and encrypted with AES-256-GCM on your machine. The key (`~/.tracevault/raw.key`) never leaves your computer, so the storage provider only sees ciphertext. This tier exists so that no data is lost if a parser has a bug.
2. **Trace tier** (`traces/`): the session converted into one shared format (user messages, assistant messages, tool calls and results), with secrets, emails, phone numbers and your home directory removed. This is the tier you train on or share.

Each trace also carries outcome labels: commits made in the session's repo during or shortly after it, and how often you interrupted the agent. These let you keep only the sessions that worked.

Database-backed agents (OpenCode, Cursor) store login tokens next to their chats, so for them tracevault extracts only the chat rows and never copies the database file.

Bucket layout:

```
contributors/<id>/raw/<agent>/<source>.zst.enc
contributors/<id>/traces/<agent>/<session>.json.gz
contributors/<id>/manifest.json
```

The `contributors/<id>` folder lets several people share one bucket without mixing data. The default id is a hash, not your username.

## Install

Requires Node.js 22.15 or newer.

```bash
git clone <this repo> && cd tracevault
npm install
npm run build
npm link        # makes the `tracevault` command available
```

## Use

```bash
tracevault scan                      # what's on this machine; uploads nothing
tracevault doctor --fix              # stop Claude Code deleting transcripts after 30 days
tracevault preview claude-code       # see a redacted session exactly as it would be uploaded

tracevault init --gcs my-bucket      # or one of the lines below
tracevault init --s3 my-bucket --endpoint https://<account>.r2.cloudflarestorage.com --profile r2
tracevault init --s3 my-bucket --endpoint https://eu2.contabostorage.com --profile contabo
tracevault init --local ~/agent-archive

tracevault sync --dry-run            # list what would be uploaded
tracevault sync                      # upload new and changed sessions
tracevault schedule                  # sync every night at 03:00 (launchd on macOS)

tracevault export --out sft.jsonl --committed-only --min-user-turns 2
tracevault restore contributors/<id>/raw/codex/<file>.zst.enc --out original.jsonl
```

Sessions are uploaded once they have been idle for 30 minutes, so an open session is not uploaded half-written. Later syncs only send what changed.

### Configuration

`~/.tracevault/config.json` (created by `init`, holds no secrets):

| Field | Meaning |
|---|---|
| `storage` | `{ "type": "gcs", "bucket" }`, `{ "type": "s3", "bucket", "endpoint", "region", "profile" }` or `{ "type": "local", "dir" }` |
| `contributor` | Folder name for your data in a shared bucket |
| `idleMinutes` | How long a session must be untouched before upload (default 30) |
| `excludePaths` | Skip sessions whose working directory contains any of these strings, e.g. a client's repo |
| `denylist` | Words always removed from traces: your name, company or client names |
| `uploadRaw` | Set to `false` to upload only redacted traces |

Set `TRACEVAULT_HOME` to keep config and state somewhere other than `~/.tracevault`.

### Credentials

tracevault never stores storage credentials.

| Backend | Credentials come from |
|---|---|
| Google Cloud Storage | `gcloud auth login` (or the `GOOGLE_OAUTH_ACCESS_TOKEN` env var) |
| S3, R2, Contabo, Backblaze | the AWS credential chain: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, or a profile in `~/.aws/credentials` |

**Back up `~/.tracevault/raw.key`**, for example in a password manager. Without it the raw tier cannot be decrypted.

## Before you share data

1. Run `tracevault preview` on a few sessions and read them.
2. Add your name, employer and client names to `denylist`, and private repos to `excludePaths`.
3. Code written for an employer or client may not be yours to share.
4. Provider terms (Anthropic, OpenAI and others) restrict using model outputs to train competing models. Check the terms that apply to you before training on assistant turns.

Redaction is pattern-based. It catches common key formats, credentials in URLs and assignments, random-looking tokens, emails and phone numbers, but it cannot guarantee every secret is found.

## Development

```bash
npm test            # Jest unit and end-to-end tests (no network, fake home dir)
npm run typecheck
npm run build
```

Adding an agent: write an `Adapter` (see `src/types.ts`) in `src/adapters/` and register it in `src/adapters/index.ts`. If you don't have a parser yet, a `rawFileAdapter` entry in `src/adapters/rawFiles.ts` is enough to start archiving.

## Deployment

There is no server. It runs on each contributor's machine. A shared intake service that issues per-contributor upload links (so contributors never need bucket credentials) is planned.
