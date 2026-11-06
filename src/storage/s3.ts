/**
 * S3-compatible backend: AWS S3, Cloudflare R2, Contabo, Backblaze B2, MinIO.
 *
 * Credentials come from the standard AWS chain (env vars or a named profile in
 * ~/.aws/credentials), so tracevault never stores keys itself.
 */
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-provider-ini";
import type { S3StorageConfig } from "../config";
import { joinKey, withRetry, type Storage } from "./index";

export class S3Storage implements Storage {
  private readonly client: S3Client;

  constructor(private readonly cfg: S3StorageConfig) {
    this.client = new S3Client({
      region: cfg.region ?? "auto",
      endpoint: cfg.endpoint,
      // Non-AWS providers generally need path-style URLs (endpoint/bucket/key).
      forcePathStyle: Boolean(cfg.endpoint),
      credentials: cfg.profile ? fromIni({ profile: cfg.profile }) : undefined,
    });
  }

  describe(): string {
    return `s3://${joinKey(this.cfg.bucket, this.cfg.prefix ?? "")}${this.cfg.endpoint ? ` (${this.cfg.endpoint})` : ""}`;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const Key = joinKey(this.cfg.prefix, key);
    await withRetry(`upload ${Key}`, () =>
      this.client.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key, Body: body, ContentType: contentType })),
    );
  }

  async get(key: string): Promise<Buffer> {
    const Key = joinKey(this.cfg.prefix, key);
    return withRetry(`download ${Key}`, async () => {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key }));
      return Buffer.from(await res.Body!.transformToByteArray());
    });
  }

  async list(prefix: string): Promise<string[]> {
    const full = joinKey(this.cfg.prefix, prefix);
    const strip = this.cfg.prefix ? joinKey(this.cfg.prefix, "").length + 1 : 0;
    const out: string[] = [];
    let token: string | undefined;
    do {
      const res = await withRetry(`list ${full}`, () =>
        this.client.send(new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: full, ContinuationToken: token })),
      );
      for (const o of res.Contents ?? []) if (o.Key) out.push(o.Key.slice(strip));
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
}
