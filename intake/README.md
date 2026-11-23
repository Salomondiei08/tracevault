# tracevault Friend Intake Server

Zero-dependency Cloud Run / container service that lets friends upload **redacted traces only** into your GCS bucket without `gcloud`, AWS keys, or read/list access to anyone else's data.

## Security Guarantees

- Each friend receives a random bearer token (`tv_<64-hex>`). The server only stores SHA-256 hashes in `TRACEVAULT_TOKENS_JSON`.
- Every upload path is forced server-side under `contributors/<token-contributor>/...` (clients cannot spoof `contributor` or write outside their prefix).
- `raw/` objects are rejected (`403`) unless the token explicitly enables `allowRaw: true`.
- Friends only receive single-object short-lived V4 `PUT` signed URLs (`15 min` expiry); they have **zero** read or list permissions (`get` / `list` fail).
- Per-contributor rate limiting (`600` mint requests/hour) and `25 MiB` max object size apply by default.

## 1. Build locally before deploying

```bash
npm run build
```

## 2. Create a dedicated Cloud Run service account (least privilege)

Grant the intake service account only object creation on your bucket + self-signing permission (`iam.serviceAccountTokenCreator`) so it can sign V4 PUT URLs via the Cloud Run metadata server without any JSON key file:

```bash
PROJECT_ID=YOUR_GCP_PROJECT_ID
BUCKET=YOUR_GCS_BUCKET
SA_NAME=tracevault-intake
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud iam service-accounts create "$SA_NAME" --project="$PROJECT_ID" --display-name="TraceVault Friend Intake"

# Bucket write-only (no read/list needed unless overwriting manifest/updated sessions)
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/storage.objectUser"

# Required for Cloud Run IAM signBlob V4 signed URLs (no JSON key file!)
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/iam.serviceAccountTokenCreator"
```

## 3. Generate a friend token

```bash
node dist/intake/tokenGen.js friend-alex --intake-url https://YOUR-INTAKE-URL.run.app
```

Store the resulting JSON object inside Google Secret Manager (`TRACEVAULT_TOKENS_JSON`), or merge new friend entries when onboarding additional people.

## 4. Deploy to Cloud Run

```bash
printf '%s' '{"<sha256-hash>":{"contributor":"friend-alex","allowRaw":false}}' | \
  gcloud secrets create tracevault-intake-tokens --data-file=- --project="$PROJECT_ID"

gcloud run deploy tracevault-intake \
  --source=. \
  --dockerfile=intake/Dockerfile \
  --project="$PROJECT_ID" \
  --region=us-central1 \
  --service-account="$SA_EMAIL" \
  --allow-unauthenticated \
  --set-env-vars="TRACEVAULT_BUCKET=${BUCKET}" \
  --set-secrets="TRACEVAULT_TOKENS_JSON=tracevault-intake-tokens:latest"
```

*(Copy `intake/Dockerfile` to `./Dockerfile` temporarily if `gcloud run deploy --source=.` requires root `Dockerfile`, or build via `gcloud builds submit`.)*

## 5. Revoke or delete a friend's data

- **Revoke upload access:** Remove their SHA-256 key from Secret Manager (`tracevault-intake-tokens`) and deploy a new revision / secret version.
- **Delete all stored data for a friend:**
  ```bash
  gcloud storage rm -r "gs://${BUCKET}/contributors/friend-alex/**"
  ```
