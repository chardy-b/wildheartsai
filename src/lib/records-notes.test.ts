import { describe, expect, it, vi } from "vitest";
import type { ConnectionSecrets } from "@/lib/epic/connections";
import { EpicError, ReconnectRequiredError } from "@/lib/epic/errors";
import { readNote } from "./records-notes";

const connection: ConnectionSecrets = {
  id: "conn-1",
  organizationName: "North Clinic",
  fhirBaseUrl: "https://north.example/R4",
  scope: "s",
  connectedAt: new Date(),
  tokenEndpoint: "https://north.example/token",
  patientId: "p1",
  accessToken: "at",
  refreshToken: "rt",
  accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
};

const binary = (contentType: string, text: string) => ({ resourceType: "Binary", contentType, data: Buffer.from(text).toString("base64") });

describe("readNote", () => {
  it("reads the note through the person's own connection and returns plain text", async () => {
    const read = vi.fn().mockResolvedValue(binary("text/html", "<p>Plan:&nbsp;rest</p>"));
    const result = await readNote({ connections: [connection], connectionId: "conn-1", attachmentUrl: "Binary/b1" }, { accessToken: async () => "fresh", read });
    expect(result).toEqual({ ok: true, text: "Plan: rest" });
    expect(read).toHaveBeenCalledWith({ baseUrl: connection.fhirBaseUrl, path: "Binary/b1", accessToken: "fresh" });
  });

  it("refuses a connection that isn't one of the person's own", async () => {
    const read = vi.fn();
    const result = await readNote({ connections: [connection], connectionId: "someone-else", attachmentUrl: "Binary/b1" }, { accessToken: async () => "at", read });
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(read).not.toHaveBeenCalled();
  });

  it("reports formats it can't show, reconnects and other failures", async () => {
    const deps = (read: () => Promise<unknown>) => ({ accessToken: async () => "at", read: vi.fn(read) });
    const input = { connections: [connection], connectionId: "conn-1", attachmentUrl: "Binary/b1" };
    expect(await readNote(input, deps(async () => binary("application/pdf", "%PDF")))).toEqual({ ok: false, reason: "unsupported" });
    expect(await readNote(input, deps(async () => ({ resourceType: "OperationOutcome" })))).toEqual({ ok: false, reason: "unavailable" });
    expect(await readNote(input, { accessToken: async () => { throw new ReconnectRequiredError(); }, read: vi.fn() })).toEqual({ ok: false, reason: "reconnect" });
    expect(await readNote(input, deps(async () => { throw new EpicError("fhir", undefined, "invalid_path"); }))).toEqual({ ok: false, reason: "unavailable" });
  });
});
