import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("PDF renderer assets", () => {
  it("serves the bundled worker with the correct MIME type", async () => {
    const response = await GET(new Request("https://app.example"), { params: Promise.resolve({ asset: ["build", "pdf.worker.min.mjs"] }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
  });
  it.each([
    ["..", ".env.local"], ["build", "../../.env.local"], ["build", "pdf.mjs"],
    ["standard_fonts", "file.txt"], ["build", "pdf.worker.min.mjs", "extra"],
  ])("rejects paths outside the allowed library assets: %j", async (...asset) => {
    expect((await GET(new Request("https://app.example"), { params: Promise.resolve({ asset }) })).status).toBe(404);
  });
});
