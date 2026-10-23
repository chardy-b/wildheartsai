import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/records-keys", () => ({ recordsKey: () => Buffer.alloc(32) }));
vi.mock("@/lib/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/env", () => ({ appUrl: () => "https://app.test" }));
vi.mock("@/lib/db/rls", () => ({ asUser: vi.fn(async (_db, _owner, fn) => fn({})) }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("./fhir-store", () => ({ loadDocumentFhir: vi.fn(), DocumentFhirError: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { getSession } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { DocumentFhirError, loadDocumentFhir } from "./fhir-store";
import { documentFhirRequest } from "./fhir-http";

const id = "a1111111-1111-4111-8111-111111111111";
const request = (query = "", fileId = id) => documentFhirRequest(new Request(`https://untrusted-host.test/api/wildcards/${fileId}/fhir${query}`), { params: Promise.resolve({ id: fileId }) });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue({ user: { id: "owner" } } as Awaited<ReturnType<typeof getSession>>);
  vi.mocked(loadDocumentFhir).mockResolvedValue({ preview: { bundle: { resourceType: "Bundle", type: "collection", entry: [] } } } as unknown as NonNullable<Awaited<ReturnType<typeof loadDocumentFhir>>>);
});

describe("document FHIR HTTP boundary", () => {
  it("requires a session and rejects malformed identifiers before loading data", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    expect((await request()).status).toBe(401);
    expect(loadDocumentFhir).not.toHaveBeenCalled();
    vi.mocked(getSession).mockResolvedValue({ user: { id: "owner" } } as Awaited<ReturnType<typeof getSession>>);
    expect((await request("", "invalid")).status).toBe(404);
    expect((await request("?runId=invalid")).status).toBe(404);
    expect(loadDocumentFhir).not.toHaveBeenCalled();
  });

  it("uses the authenticated owner and configured source origin, returns private FHIR and audits downloads", async () => {
    const response = await request(`?download=1&runId=${id}&userId=other`);
    expect(response.status).toBe(200);
    expect(loadDocumentFhir).toHaveBeenCalledWith({}, expect.any(Buffer), "owner", id, "https://app.test", id);
    expect(response.headers.get("content-type")).toContain("application/fhir+json");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(recordAudit).toHaveBeenCalledWith({}, { userId: "owner", action: "export", detail: { records: 0, document: true } }, expect.any(Date));
  });

  it("hides unavailable files and internal error details, but explains an integrity mismatch", async () => {
    vi.mocked(loadDocumentFhir).mockResolvedValue(null);
    expect((await request()).status).toBe(404);
    vi.mocked(loadDocumentFhir).mockRejectedValue(new Error("private decrypted source"));
    const failure = await request();
    expect(failure.status).toBe(500);
    expect(await failure.text()).not.toContain("private decrypted source");
    vi.mocked(loadDocumentFhir).mockRejectedValue(new DocumentFhirError(409, "Source mismatch"));
    expect((await request()).status).toBe(409);
  });
});
