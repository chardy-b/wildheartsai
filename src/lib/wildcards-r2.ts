import "server-only";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "./env";
import { SINGLE_OBJECT_BYTES } from "./wildcards";

export interface FileObjects {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export function r2Configured(): boolean { return Boolean(env().R2_BUCKET_NAME); }

let cached: FileObjects | undefined;
export function fileObjects(): FileObjects {
  if (cached) return cached;
  const config = env();
  if (!config.R2_ACCOUNT_ID || !config.R2_BUCKET_NAME || !config.R2_ACCESS_KEY_ID || !config.R2_SECRET_ACCESS_KEY) {
    throw new Error("R2 storage is not configured");
  }
  const Bucket = config.R2_BUCKET_NAME;
  const client = new S3Client({
    region: "auto", endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.R2_ACCESS_KEY_ID, secretAccessKey: config.R2_SECRET_ACCESS_KEY },
    maxAttempts: 3,
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
  });
  cached = {
    async put(Key, Body) {
      // Only ciphertext and an opaque random key leave the app. No original name,
      // user/patient identifier, MIME type, or public/signed URL is sent to R2.
      await client.send(new PutObjectCommand({ Bucket, Key, Body, ContentType: "application/octet-stream", CacheControl: "private, no-store" }), { abortSignal: AbortSignal.timeout(20_000) });
    },
    async get(Key) {
      const response = await client.send(new GetObjectCommand({ Bucket, Key }), { abortSignal: AbortSignal.timeout(20_000) });
      if (!response.Body) throw new Error("Object is missing");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > SINGLE_OBJECT_BYTES + 29) throw new Error("Object exceeds the file limit");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, size);
    },
    async delete(Key) { await client.send(new DeleteObjectCommand({ Bucket, Key }), { abortSignal: AbortSignal.timeout(20_000) }); },
  };
  return cached;
}
