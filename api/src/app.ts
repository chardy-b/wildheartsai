import { Hono } from "hono";
import type { Bindings } from "./env";
import { authRoutes } from "./routes/auth";

// Every route lives under /api, at the same paths the Next app serves today, so browsers, Epic
// and the VPS services see no change. Requests arrive from the web Worker's service binding.
export const app = new Hono<{ Bindings: Bindings }>().basePath("/api");

// Unauthenticated liveness check: no bindings, no secrets, no dependencies.
app.get("/health", (c) => c.json({ status: "ok", service: "wildheartsai" }, 200, { "Cache-Control": "no-store" }));

app.route("/", authRoutes);

app.notFound((c) => c.json({ error: "not_found" }, 404));

// Never echo internal errors: they can carry SQL, identifiers or upstream responses.
app.onError((error, c) => {
  console.error("[api] unhandled error", error instanceof Error ? error.name : "unknown");
  return c.json({ error: "internal_error" }, 500);
});
