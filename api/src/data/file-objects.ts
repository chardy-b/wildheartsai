import { SINGLE_OBJECT_BYTES } from "@/lib/wildcards";

// Encrypted document bytes in R2, through the FILES binding (src/lib/wildcards-r2.ts in the Next app
// used the S3 API with keys). Only ciphertext and an opaque random key leave the app: no name,
// person or patient identifier, MIME type, or public or signed URL is ever given to R2.
export type FileObjects = {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
};

export function fileObjects(bucket: R2Bucket): FileObjects {
  return {
    async put(key, bytes) {
      await bucket.put(key, bytes, { httpMetadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" } });
    },
    async get(key) {
      const object = await bucket.get(key);
      if (!object) throw new Error("Object is missing");
      // The largest object is a single-object file plus its 29-byte envelope.
      if (object.size > SINGLE_OBJECT_BYTES + 29) throw new Error("Object exceeds the file limit");
      return Buffer.from(await object.arrayBuffer());
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}
