import { createHash } from "node:crypto";
import { Hono } from "hono";
import { demoPdf } from "@/lib/demo/pdf";
import { demoSnapshot, ensureDemoChart, issueGuestViewer } from "../data/demo";
import { database } from "../db";
import { secrets } from "../env";
import { recordsKey } from "../epic/credentials";
import { applicationSession, realSession, type AppEnv } from "../session";

// The guided demo (src/lib/demo/http.ts and src/app/(auth)/demo/actions.ts in the Next app), on
// rails: one central fictional chart, and no endpoint here writes anything for a visitor. The
// walkthrough's steps (replay the sync, reset, add the sample PDF) answer what the chart already
// holds; the page keeps track of which step the visitor is on.
export const demoRoutes = new Hono<AppEnv>();

const PRIVATE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const answer = (data: unknown, status = 200) => Response.json(data, { status, headers: PRIVATE });
const digest = (input: Uint8Array) => createHash("sha256").update(input).digest("hex");
const failed = (what: string, error: unknown) => {
  console.error(`[demo] ${what} failed`, error instanceof Error ? error.name : "unknown");
  return answer({ error: "The demo could not open. Please try again." }, 500);
};

// A signed-in person opening the demo. The web Worker's entry action calls this, then sets the
// demo-mode cookie bound to this login. Nothing is created for the person.
demoRoutes.post("/demo/workspace", async (c) => {
  const identity = await realSession(c.env, c.req.raw.headers);
  if (!identity?.user.emailVerified) return answer({ error: "Sign in with your Wild Hearts account to open the demo." }, 401);
  try {
    await ensureDemoChart(c.env, database(c.env.DB), recordsKey(secrets(c.env)));
  } catch (error) {
    return failed("chart", error);
  }
  return answer({ ok: true });
});

// A visitor without an account: a signed viewer cookie for a day, and nothing stored for it.
// The web Worker's entry action sets it (httpOnly).
demoRoutes.post("/demo/guest", async (c) => {
  if (await realSession(c.env, c.req.raw.headers)) return answer({ error: "You're signed in. Open the demo from your account." }, 409);
  try {
    await ensureDemoChart(c.env, database(c.env.DB), recordsKey(secrets(c.env)));
  } catch (error) {
    return failed("chart", error);
  }
  return answer(issueGuestViewer(secrets(c.env).BETTER_AUTH_SECRET), 201);
});

demoRoutes.on(["GET", "POST"], "/demo/*", async (c) => {
  const request = c.req.raw;
  const identity = await applicationSession(c.env, request.headers);
  if (!identity) return answer({ error: "Open the demo again from the demo page." }, 401);
  if (!("demo" in identity)) return answer({ error: "Not found." }, 404);
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/demo\//, "");
  if (request.method !== "GET" && (request.headers.get("origin") !== url.origin || request.headers.get("sec-fetch-site") === "cross-site")) return answer({ error: "Request not allowed." }, 403);
  const db = database(c.env.DB), kek = recordsKey(secrets(c.env));
  const snapshot = (document: boolean) => demoSnapshot(db, kek, { document });
  try {
    if (request.method === "GET" && route === "sample.pdf") {
      return new Response(new Uint8Array(demoPdf()), { headers: { ...PRIVATE, "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="alex-morgan-demo-report.pdf"' } });
    }
    // Replaying the sync shows the chart as it is; `document=1` keeps the PDF step's records.
    if (request.method === "POST" && route === "sync") return answer(await snapshot(url.searchParams.get("document") === "1"));
    if (request.method === "POST" && route === "reset") return answer(await snapshot(false));
    if (request.method === "POST" && route === "document") {
      // Only the supplied synthetic fixture is accepted: never label a visitor's own document as
      // read, or turn it into invented facts. Its records are already in the chart.
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
      return answer(await snapshot(true));
    }
    if (request.method === "GET" && (route === "snapshot" || route === "fhir")) {
      const found = await snapshot(route === "fhir" || url.searchParams.get("document") === "1");
      if (!found) return answer({ error: "Return to the demo entry page and open the guided demo again." }, 409);
      if (route === "snapshot") return answer(found);
      const type = url.searchParams.get("type") ?? "", query = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
      if (query.length > 200 || type.length > 60) return answer({ error: "Search is too long." }, 400);
      const resources = found.records.filter((r) => (!type || r.resourceType === type) && (!query || JSON.stringify(r.resource).toLowerCase().includes(query)));
      return answer({ resourceType: "Bundle", type: "searchset", total: resources.length, meta: { tag: [{ code: "demo-local-store", display: "Wild Hearts local FHIR search; not a Medplum server" }] }, entry: resources.map((r) => ({ fullUrl: `urn:uuid:${r.id}`, resource: r.resource })) });
    }
    return answer({ error: "Not found." }, 404);
  } catch (error) {
    console.error("[demo] step failed", error instanceof Error ? error.name : "unknown");
    return answer({ error: "The demo could not complete this step. Try again." }, 500);
  }
});
