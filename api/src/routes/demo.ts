import { createHash } from "node:crypto";
import { Hono } from "hono";
import { isDemoIdentity } from "@/lib/demo/identity";
import { demoPdf } from "@/lib/demo/pdf";
import { demoSnapshot, ensureDemoWorkspace, importDemoDocument, populateDemo } from "../data/demo";
import { database } from "../db";
import { secrets } from "../env";
import { recordsKey } from "../epic/credentials";
import { applicationSession, realSession, type AppEnv } from "../session";

// The guided demo (src/lib/demo/http.ts and src/app/(auth)/demo/actions.ts in the Next app).
export const demoRoutes = new Hono<AppEnv>();

const PRIVATE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const answer = (data: unknown, status = 200) => Response.json(data, { status, headers: PRIVATE });
const digest = (input: Uint8Array) => createHash("sha256").update(input).digest("hex");

// Opens (or reopens) the signed-in person's own workspace. The web Worker's demo entry action
// calls this, then sets the cookie that selects the workspace for this login.
demoRoutes.post("/demo/workspace", async (c) => {
  if (secrets(c.env).DEMO_ENABLED !== "1") return answer({ error: "Not found." }, 404);
  const identity = await realSession(c.env, c.req.raw.headers);
  if (!identity?.user.emailVerified) return answer({ error: "Sign in with your Wild Hearts account to open the demo." }, 401);
  if (isDemoIdentity(identity.user.id)) return answer({ ok: true });
  try {
    await ensureDemoWorkspace(c.env, database(c.env.DB), recordsKey(secrets(c.env)), identity);
  } catch (error) {
    console.error("[demo] workspace failed", error instanceof Error ? error.name : "unknown");
    return answer({ error: "The demo could not open. Please try again." }, 500);
  }
  return answer({ ok: true });
});

demoRoutes.on(["GET", "POST"], "/demo/*", async (c) => {
  const request = c.req.raw;
  const identity = await applicationSession(c.env, request.headers);
  if (!identity || !identity.user.emailVerified) return answer({ error: "Sign in with your Wild Hearts account to open the demo." }, 401);
  const config = secrets(c.env);
  if (config.DEMO_ENABLED !== "1" || !isDemoIdentity(identity.user.id)) return answer({ error: "Not found." }, 404);
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/demo\//, "");
  if (request.method !== "GET" && (request.headers.get("origin") !== url.origin || request.headers.get("sec-fetch-site") === "cross-site")) return answer({ error: "Request not allowed." }, 403);
  const db = database(c.env.DB), kek = recordsKey(config), userId = identity.user.id;
  try {
    if (request.method === "GET" && route === "sample.pdf") {
      return new Response(new Uint8Array(demoPdf()), { headers: { ...PRIVATE, "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="alex-morgan-demo-report.pdf"' } });
    }
    if (request.method === "POST" && (route === "sync" || route === "reset")) {
      await populateDemo(c.env, db, kek, userId, { reset: route === "reset" });
      return answer(await demoSnapshot(db, kek, userId));
    }
    if (request.method === "POST" && route === "document") {
      // Only the supplied synthetic fixture is accepted. Never label arbitrary user documents
      // as successfully OCR'd or turn them into invented facts.
      const reader = request.body?.getReader();
      if (!reader) return answer({ error: "Choose the provided sample PDF." }, 400);
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 64000) {
          await reader.cancel();
          return answer({ error: "Use the provided small demo PDF. Other documents belong in Documents." }, 413);
        }
        chunks.push(item.value);
      }
      if (digest(Buffer.concat(chunks)) !== digest(demoPdf())) return answer({ error: "This guided replay accepts only the provided sample PDF. Use Documents for real extraction." }, 422);
      await importDemoDocument(c.env, db, kek, userId);
      return answer(await demoSnapshot(db, kek, userId));
    }
    if (request.method === "GET" && (route === "snapshot" || route === "fhir")) {
      const snapshot = await demoSnapshot(db, kek, userId);
      if (!snapshot) return answer({ error: "Return to the demo entry page and open the guided demo again." }, 409);
      if (route === "snapshot") return answer(snapshot);
      const type = url.searchParams.get("type") ?? "", query = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
      if (query.length > 200 || type.length > 60) return answer({ error: "Search is too long." }, 400);
      const resources = snapshot.records.filter((r) => (!type || r.resourceType === type) && (!query || JSON.stringify(r.resource).toLowerCase().includes(query)));
      return answer({ resourceType: "Bundle", type: "searchset", total: resources.length, meta: { tag: [{ code: "demo-local-store", display: "Wild Hearts local FHIR search; not a Medplum server" }] }, entry: resources.map((r) => ({ fullUrl: `urn:uuid:${r.id}`, resource: r.resource })) });
    }
    return answer({ error: "Not found." }, 404);
  } catch (error) {
    console.error("[demo] step failed", error instanceof Error ? error.name : "unknown");
    return answer({ error: "The demo could not complete this step. Try again." }, 500);
  }
});
