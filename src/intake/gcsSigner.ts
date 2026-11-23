/**
 * Pure-Node Google Cloud Storage V4 Signed PUT URL generator.
 *
 * Uses either a PEM RSA private key (for local testing or service-account JSON keys)
 * or the Cloud Run GCE metadata server + IAM Credentials `signBlob` API with zero
 * external SDK dependencies.
 */
import { createHash, sign } from "node:crypto";

export interface GcsSignOptions {
  bucket: string;
  objectName: string;
  contentType: string;
  contentLength: number;
  expiresSeconds?: number;
  signerEmail: string;
  signBytes: (toSign: Buffer) => Promise<Buffer>;
  now?: Date;
}

function rfc3986Encode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeObjectPath(objectName: string): string {
  return objectName
    .replace(/^\/+/, "")
    .split("/")
    .map((seg) => rfc3986Encode(seg))
    .join("/");
}

function formatGcsDate(d: Date): { dateStamp: string; isoStamp: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateStamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const isoStamp = `${dateStamp}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return { dateStamp, isoStamp };
}

/** Signs bytes locally using a PKCS#8 / PEM RSA private key. */
export function createPemSigner(privateKeyPem: string): (toSign: Buffer) => Promise<Buffer> {
  return async (toSign) => sign("RSA-SHA256", toSign, privateKeyPem);
}

/** Signs bytes on Cloud Run using the attached service account + IAM Credentials `signBlob`. */
export function createCloudRunSigner(explicitEmail?: string): {
  getEmail: () => Promise<string>;
  signBytes: (toSign: Buffer) => Promise<Buffer>;
} {
  let cachedEmail = explicitEmail?.trim();
  const metaHeaders = { "Metadata-Flavor": "Google" };

  const getToken = async (): Promise<string> => {
    const res = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
      headers: metaHeaders,
    });
    if (!res.ok) throw new Error(`Metadata token error (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as { access_token?: string };
    if (!data.access_token) throw new Error("Metadata server returned no access_token");
    return data.access_token;
  };

  const getEmail = async (): Promise<string> => {
    if (cachedEmail) return cachedEmail;
    const res = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email", {
      headers: metaHeaders,
    });
    if (!res.ok) throw new Error(`Metadata email error (${res.status}): ${await res.text()}`);
    cachedEmail = (await res.text()).trim();
    return cachedEmail;
  };

  const signBytes = async (toSign: Buffer): Promise<Buffer> => {
    const [email, token] = await Promise.all([getEmail(), getToken()]);
    const res = await fetch(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:signBlob`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ payload: toSign.toString("base64") }),
      },
    );
    if (!res.ok) throw new Error(`IAM signBlob error (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as { signedBlob?: string };
    if (!data.signedBlob) throw new Error("IAM signBlob returned no signedBlob");
    return Buffer.from(data.signedBlob, "base64");
  };

  return { getEmail, signBytes };
}

/** Generates a GCS V4 Signed PUT URL scoped strictly to `objectName` and `contentType`. */
export async function signGcsV4PutUrl(opts: GcsSignOptions): Promise<{ uploadUrl: string; headers: Record<string, string> }> {
  const expires = Math.max(1, Math.min(604_800, Math.floor(opts.expiresSeconds ?? 900)));
  const { dateStamp, isoStamp } = formatGcsDate(opts.now ?? new Date());
  const credentialScope = `${dateStamp}/auto/storage/goog4_request`;
  const credential = `${opts.signerEmail}/${credentialScope}`;
  const canonicalUri = `/${encodeURIComponent(opts.bucket)}/${encodeObjectPath(opts.objectName)}`;
  const signedHeaders = "content-type;host";

  const params: [string, string][] = [
    ["X-Goog-Algorithm", "GOOG4-RSA-SHA256"],
    ["X-Goog-Credential", credential],
    ["X-Goog-Date", isoStamp],
    ["X-Goog-Expires", String(expires)],
    ["X-Goog-SignedHeaders", signedHeaders],
  ];
  params.sort((a, b) => a[0].localeCompare(b[0]));
  const canonicalQuery = params.map(([k, v]) => `${rfc3986Encode(k)}=${rfc3986Encode(v)}`).join("&");

  const canonicalHeaders = `content-type:${opts.contentType}\nhost:storage.googleapis.com\n`;
  const canonicalRequest = ["PUT", canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const requestHash = createHash("sha256").update(canonicalRequest, "utf8").digest("hex");
  const stringToSign = ["GOOG4-RSA-SHA256", isoStamp, credentialScope, requestHash].join("\n");
  const sigHex = (await opts.signBytes(Buffer.from(stringToSign, "utf8"))).toString("hex");

  return {
    uploadUrl: `https://storage.googleapis.com${canonicalUri}?${canonicalQuery}&X-Goog-Signature=${sigHex}`,
    headers: { "Content-Type": opts.contentType },
  };
}
