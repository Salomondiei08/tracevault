/**
 * Entrypoint for running the tracevault friend intake server (Cloud Run or self-hosted).
 *
 * Environment variables:
 *   PORT                    HTTP port (default 8080)
 *   TRACEVAULT_TOKENS_JSON  JSON mapping sha256(token) -> { contributor, allowRaw?, maxBytes? }
 *   TRACEVAULT_BUCKET       Target GCS bucket (required unless TRACEVAULT_LOCAL_DIR is set)
 *   TRACEVAULT_PREFIX       Optional object prefix inside the bucket
 *   GCS_SIGNER_EMAIL        Optional service-account email override for V4 signing
 *   GCS_SIGNER_KEY_PEM      Optional PEM private key (if unset, uses Cloud Run metadata + IAM signBlob)
 *   TRACEVAULT_LOCAL_DIR    Optional local directory sink for standalone self-hosted testing
 */
import { createCloudRunSigner, createPemSigner, signGcsV4PutUrl } from "./gcsSigner";
import { createIntakeServer, type IntakeServerOptions, type TokenEntry } from "./server";

function loadTokens(): Record<string, TokenEntry> {
  const raw = process.env.TRACEVAULT_TOKENS_JSON?.trim();
  if (!raw) throw new Error("TRACEVAULT_TOKENS_JSON environment variable is required");
  return JSON.parse(raw) as Record<string, TokenEntry>;
}

function buildOptions(): IntakeServerOptions {
  const tokens = loadTokens();
  const prefix = process.env.TRACEVAULT_PREFIX?.trim() || undefined;
  const localDir = process.env.TRACEVAULT_LOCAL_DIR?.trim() || undefined;
  const bucket = process.env.TRACEVAULT_BUCKET?.trim();

  if (localDir) {
    return { tokens, prefix, localDir };
  }
  if (!bucket) {
    throw new Error("TRACEVAULT_BUCKET (or TRACEVAULT_LOCAL_DIR for local mode) is required");
  }

  const keyPem = process.env.GCS_SIGNER_KEY_PEM?.replace(/\\n/g, "\n");
  const explicitEmail = process.env.GCS_SIGNER_EMAIL?.trim();
  const cloudSigner = keyPem ? undefined : createCloudRunSigner(explicitEmail);
  const pemSigner = keyPem ? createPemSigner(keyPem) : undefined;

  return {
    tokens,
    prefix,
    async createUploadTarget({ objectName, contentType, contentLength }) {
      const signerEmail = explicitEmail || (await cloudSigner!.getEmail());
      const signBytes = pemSigner ?? cloudSigner!.signBytes;
      return signGcsV4PutUrl({
        bucket,
        objectName,
        contentType,
        contentLength,
        signerEmail,
        signBytes,
      });
    },
  };
}

const port = Number(process.env.PORT ?? 8080);
const server = createIntakeServer(buildOptions());
server.listen(port, () => {
  console.log(`tracevault intake server listening on :${port}`);
});
