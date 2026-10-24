import "server-only";
import { createHash } from "node:crypto";
import { applicationSession } from "@/lib/application-session";
import { db } from "@/lib/db";
import { recordsKey } from "@/lib/records-keys";
import { isDemoUser } from "./access";
import { demoSnapshot, importDemoDocument, populateDemo } from "./store";
import { demoPdf } from "./pdf";

const response = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });

export async function demoRequest(request: Request, path: string[]): Promise<Response> {
  const identity = await applicationSession(request.headers);
  if (!identity || !identity.user.emailVerified) return response({ error: "Sign in with your Wild Hearts account to open the demo." }, 401);
  if (!isDemoUser(identity.user.id)) return response({ error: "Not found." }, 404);
  const url = new URL(request.url), route = path.join("/");
  if (request.method !== "GET" && (request.headers.get("origin") !== url.origin || request.headers.get("sec-fetch-site") === "cross-site")) return response({ error: "Request not allowed." }, 403);
  try {
    if (request.method === "GET" && route === "sample.pdf") return new Response(new Uint8Array(demoPdf()), { headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="alex-morgan-demo-report.pdf"', "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
    if (request.method === "POST" && ["sync", "reset"].includes(route)) {
      await populateDemo(db, recordsKey(), identity.user.id, { reset: route === "reset" });
      return response(await demoSnapshot(db, recordsKey(), identity.user.id));
    }
    if (request.method === "POST" && route === "document") {
      // Only the supplied synthetic fixture is accepted. Never label arbitrary
      // user documents as successfully OCR'd or turn them into invented facts.
      const reader = request.body?.getReader();
      if (!reader) return response({ error: "Choose the provided sample PDF." }, 400);
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 64000) { await reader.cancel(); return response({ error: "Use the provided small demo PDF. Other documents belong in Documents." }, 413); } chunks.push(item.value); }
      const bytes = Buffer.concat(chunks);
      const digest = (input: Buffer) => createHash("sha256").update(input).digest("hex");
      if (digest(bytes) !== digest(demoPdf())) return response({ error: "This guided replay accepts only the provided sample PDF. Use Documents for real extraction." }, 422);
      await importDemoDocument(db, recordsKey(), identity.user.id);
      return response(await demoSnapshot(db, recordsKey(), identity.user.id));
    }
    if (request.method === "GET" && ["snapshot", "fhir"].includes(route)) {
      const snapshot = await demoSnapshot(db, recordsKey(), identity.user.id);
      if (!snapshot) return response({ error: "Return to the demo entry page and open the guided demo again." }, 409);
      if (route === "snapshot") return response(snapshot);
      const type = url.searchParams.get("type") ?? "", query = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
      if (query.length > 200 || type.length > 60) return response({ error: "Search is too long." }, 400);
      const resources = snapshot.records.filter(r => (!type || r.resourceType === type) && (!query || JSON.stringify(r.resource).toLowerCase().includes(query)));
      return response({ resourceType: "Bundle", type: "searchset", total: resources.length, meta: { tag: [{ code: "demo-local-store", display: "Wild Hearts local FHIR search; not a Medplum server" }] }, entry: resources.map(r => ({ fullUrl: `urn:uuid:${r.id}`, resource: r.resource })) });
    }
    return response({ error: "Not found." }, 404);
  } catch { return response({ error: "The demo could not complete this step. Try again." }, 500); }
}
