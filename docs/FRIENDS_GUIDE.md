# Contributing Traces Safely (Friends Guide)

Share only **personal coding sessions** — scrubbed locally before upload — using a write-only invite token.

## What is shared (and what stays on your laptop)

- **Write-only intake mode (`--no-raw` default):** Only normalized, redacted session traces (`traces/*.json.gz`) are uploaded. Original unredacted files never leave your machine.
- **Scrubbed locally before upload:**
  - Known API keys (`sk-ant-`, `sk-`, `sk-or-v1-`, `ghp_`, `AKIA`, `AIza`, `sbp_`, `re_`, `vcp_`, Telegram bot tokens, JWTs, auth headers, DB URLs)
  - Emails, international phones, private/Tailscale IPv4 addresses, high-entropy secrets
  - Your `$HOME` path (`~`), `user@host` prefixes, `cwd`, `gitBranch`, and commit messages
  - `tool_result` outputs from reading `.env*`, `~/.ssh/id_*`, `~/.aws/credentials`, `*.pem`, or `service-account*.json`
  - Any repo path in `excludePaths` and any word/company/name in `denylist`
- **No bucket access needed:** Your token can only upload to your own `contributors/<id>/` folder. You cannot read or list anyone else's data, and nobody else has your token.

## 1. Run directly via `npx` or install locally (5 minutes)

Only share sessions from **personal / open-source repos**. Exclude all employer, school-exam, or client folders first.

**Quickest (no clone required, Node.js >=22.15):**

```bash
npx github:Salomondiei08/tracevault init \
  --intake https://YOUR-INTAKE-URL.run.app \
  --token tv_YOUR_INVITE_TOKEN \
  --exclude /work --exclude /clients \
  --deny "Your Full Name" --deny "EmployerName" --deny "ClientName"

npx github:Salomondiei08/tracevault preview claude-code
npx github:Salomondiei08/tracevault sync
```

*(Or for zero-server local folder sharing: `npx github:Salomondiei08/tracevault init --local ~/Desktop/my-traces --no-raw --exclude /work --deny "Your Full Name"` then `npx github:Salomondiei08/tracevault sync`.)*

**Or clone locally:**

```bash
git clone https://github.com/Salomondiei08/tracevault.git && cd tracevault
npm ci && npm run build
npm link

# Initialize with the intake URL and personal invite token you received:
tracevault init \
  --intake https://YOUR-INTAKE-URL.run.app \
  --token tv_YOUR_INVITE_TOKEN \
  --exclude /work --exclude /clients \
  --deny "Your Full Name" --deny "EmployerName" --deny "ClientName"
```

*(Need to edit exclusions later? Open `~/.tracevault/config.json` and update `excludePaths` or `denylist`.)*

## 2. Inspect before uploading anything

```bash
tracevault scan                   # check what agents/sessions exist (uploads nothing)
tracevault preview claude-code    # read an exact redacted session as it would upload
tracevault sync --dry-run         # confirm which files would upload and how many redactions ran
```

If `preview` still shows anything personal, add that string to `denylist` or folder to `excludePaths` in `~/.tracevault/config.json` and preview again.

## 3. Run or schedule sync

```bash
tracevault sync                   # one-off upload
tracevault schedule               # nightly sync at 03:00 (macOS launchd / prints Linux timer)
```

## 4. Pause, stop, or delete your data

- **Stop automatic sync anytime:** `tracevault unschedule`
- **Remove local config/token:** `rm -rf ~/.tracevault`
- **Delete everything you uploaded:** Ask the bucket owner to run `gcloud storage rm -r gs://<bucket>/contributors/<your-id>/**` and revoke your token.
