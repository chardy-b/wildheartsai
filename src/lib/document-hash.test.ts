import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { documentHash } from "./document-hash";
import { UPLOAD_CHUNK_BYTES } from "./wildcards";

describe("bounded document fingerprints", () => {
  it("matches standard SHA-256 across piece boundaries without a whole-file read", async () => {
    const bytes = Buffer.alloc(UPLOAD_CHUNK_BYTES * 2 + 13, 0x61);
    bytes[UPLOAD_CHUNK_BYTES] = 0xff;
    const file = new Blob([bytes]);
    const whole = vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("Whole-file read"));
    expect(await documentHash(file)).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(whole).not.toHaveBeenCalled();
  });
  it("honors cancellation before reading", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(documentHash(new Blob(["hello"]), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
