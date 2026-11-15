import { env, SELF } from "cloudflare:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_STORAGE_BYTES, UPLOAD_CHUNK_BYTES } from "@/lib/wildcards";
import * as s from "../src/db/schema";
import { clearAll, db, origin, signedIn } from "./helpers";

// Documents over HTTP, as the upload client uses them, with a real (local) R2 bucket.
const pdf = (size: number, fill = 7) => {
  const bytes = Buffer.alloc(size, fill);
  bytes.write("%PDF-1.7\n", 0, "ascii");
  return bytes;
};
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function allObjects(): Promise<string[]> {
  const listed = await env.FILES.list();
  return listed.objects.map((o) => o.key);
}

function client(cookie: string) {
  const send = (method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) =>
    SELF.fetch(`${origin}${path}`, { method, headers: { cookie, Origin: origin, ...headers }, body });
  return {
    send,
    async upload(name: string, bytes: Buffer, extra: Record<string, unknown> = {}) {
      const begin = await send("POST", "/api/wildcards/uploads", JSON.stringify({ name, size: bytes.length, sha256: sha(bytes), ...extra }), { "Content-Type": "application/json" });
      const started = (await begin.json()) as { id: string; skipped?: boolean; error?: string };
      if (begin.status !== 201 || started.skipped) return { http: begin.status, ...started };
      // The pieces in parallel, as the client does.
      await Promise.all(
        Array.from({ length: Math.ceil(bytes.length / UPLOAD_CHUNK_BYTES) }, async (_, index) => {
          const piece = await send("PUT", `/api/wildcards/uploads/${started.id}/${index}`, bytes.subarray(index * UPLOAD_CHUNK_BYTES, (index + 1) * UPLOAD_CHUNK_BYTES), { "Content-Type": "application/octet-stream" });
          expect(piece.status, await piece.clone().text()).toBe(204);
        }),
      );
      const complete = await send("POST", `/api/wildcards/uploads/${started.id}/complete`);
      return { ...((await complete.json()) as object), http: complete.status, id: started.id };
    },
    async download(id: string) {
      const response = await send("GET", `/api/wildcards/${id}?download=1`);
      return { response, bytes: Buffer.from(await response.arrayBuffer()) };
    },
  };
}

beforeEach(async () => {
  await clearAll();
  for (const key of await allObjects()) await env.FILES.delete(key);
});

describe("Documents on Workers", () => {
  it("stores small files encrypted, serves them inert, and only to their owner", async () => {
    const a = client((await signedIn("a@example.test")).cookie);
    const b = client((await signedIn("b@example.test")).cookie);
    const bytes = pdf(2000);
    const saved = await a.send("POST", "/api/wildcards", bytes, { "Content-Type": "application/octet-stream", "x-file-name": encodeURIComponent("Lab results (2026).pdf") });
    expect(saved.status).toBe(201);

    const { files, usage } = (await (await a.send("GET", "/api/wildcards")).json()) as { files: { id: string; name: string; status: string }[]; usage: { count: number; bytes: number } };
    expect(files).toEqual([expect.objectContaining({ name: "Lab results (2026).pdf", type: "application/pdf", status: "ready" })]);
    expect(usage).toEqual({ count: 1, bytes: 2000 });

    const { response, bytes: downloaded } = await a.download(files[0].id);
    expect(downloaded.equals(bytes)).toBe(true);
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(response.headers.get("Content-Disposition")).toBe("attachment; filename=\"download\"; filename*=UTF-8''Lab%20results%20%282026%29.pdf");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");

    // R2 holds only ciphertext under an opaque key.
    const [key] = await allObjects();
    expect(key).toMatch(/^wildcards\/[0-9a-f-]{36}$/);
    const stored = Buffer.from(await (await env.FILES.get(key))!.arrayBuffer());
    expect(stored.includes(Buffer.from("%PDF"))).toBe(false);

    // Someone else's file looks exactly like a missing one.
    const theirs = await b.send("GET", `/api/wildcards/${files[0].id}`);
    const missing = await b.send("GET", `/api/wildcards/${crypto.randomUUID()}`);
    expect([theirs.status, await theirs.text()]).toEqual([missing.status, await missing.text()]);
    expect((await b.send("DELETE", `/api/wildcards/${files[0].id}`)).status).toBe(404);
    expect((await a.send("DELETE", `/api/wildcards/${files[0].id}`)).status).toBe(204);
    expect(await allObjects()).toEqual([]);
  });

  it("uploads in pieces, with repeated requests and pieces arriving together", async () => {
    const a = client((await signedIn("a@example.test")).cookie);
    const bytes = pdf(UPLOAD_CHUNK_BYTES * 2 + 1234);
    const requestId = crypto.randomUUID();
    // The same request twice (a lost response) reserves the file once.
    const first = await a.send("POST", "/api/wildcards/uploads", JSON.stringify({ id: requestId, name: "scan.pdf", size: bytes.length }), { "Content-Type": "application/json" });
    const again = await a.send("POST", "/api/wildcards/uploads", JSON.stringify({ id: requestId, name: "scan.pdf", size: bytes.length }), { "Content-Type": "application/json" });
    expect([first.status, again.status]).toEqual([201, 201]);
    expect(await db.$count(s.wildcardFile)).toBe(1);
    await a.send("DELETE", `/api/wildcards/${requestId}`);

    const done = await a.upload("scan.pdf", bytes);
    expect(done).toMatchObject({ http: 200, ok: true, skipped: false });
    expect((await a.download(done.id)).bytes.equals(bytes)).toBe(true);
    // Its pieces went once the file was one object.
    expect(await allObjects()).toHaveLength(1);
    // The same content again is recognised and skipped.
    expect(await a.upload("copy.pdf", bytes)).toMatchObject({ http: 201, skipped: true, id: done.id });
  });

  it("keeps files over 25 MB as pieces, streams them back, and deletes every piece", async () => {
    const a = client((await signedIn("a@example.test")).cookie);
    const bytes = pdf(26 * 1024 * 1024 + 99, 3);
    const done = await a.upload("big.pdf", bytes);
    expect(done).toMatchObject({ http: 200, ok: true });
    const { bytes: downloaded } = await a.download(done.id);
    expect(downloaded.length).toBe(bytes.length);
    expect(downloaded.equals(bytes)).toBe(true);
    expect((await allObjects()).length).toBe(Math.ceil(bytes.length / UPLOAD_CHUNK_BYTES));
    await a.send("DELETE", `/api/wildcards/${done.id}`);
    expect(await allObjects()).toEqual([]);
  });

  it("refuses an upload over the storage limit with the usual message", async () => {
    const { userId, cookie } = await signedIn("a@example.test");
    const a = client(cookie);
    await a.send("GET", "/api/wildcards"); // creates the person's data key
    await db.insert(s.wildcardFile).values({ userId, sealedMetadata: "x", objectKey: "taken", sizeBytes: MAX_STORAGE_BYTES - 100, status: "ready" });
    const refused = await a.upload("too-much.pdf", pdf(2000));
    expect(refused.http).toBe(409);
    expect(refused.error).toMatch(/^This file needs 2\.0 KB, but Documents has only 0\.1 KB available/);
    expect(await db.select().from(s.wildcardFile).where(eq(s.wildcardFile.userId, userId))).toHaveLength(1);
  });

  it("checks the origin and the session on every change", async () => {
    const { cookie } = await signedIn("a@example.test");
    const crossSite = await SELF.fetch(`${origin}/api/wildcards/uploads`, { method: "POST", headers: { cookie, Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" });
    expect([crossSite.status, ((await crossSite.json()) as { error: string }).error]).toEqual([403, "Uploads must come from Documents in this app."]);
    const signedOut = await SELF.fetch(`${origin}/api/wildcards/uploads`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" });
    expect([signedOut.status, ((await signedOut.json()) as { error: string }).error]).toEqual([401, "Your session has expired. Sign in again, then upload your file."]);
    expect((await SELF.fetch(`${origin}/api/wildcards`)).status).toBe(401);
  });

  it("refuses a file whose contents don't match its type", async () => {
    const a = client((await signedIn("a@example.test")).cookie);
    const response = await a.send("POST", "/api/wildcards", Buffer.from("not really a pdf"), { "Content-Type": "application/octet-stream", "x-file-name": "fake.pdf" });
    expect(response.status).toBe(400);
    expect(await db.$count(s.wildcardFile)).toBe(0);
  });
});
