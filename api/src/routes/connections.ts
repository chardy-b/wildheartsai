import { Hono } from "hono";
import { disconnect } from "../data/connections";
import { connectChoices } from "../data/directory";
import { deleteSource, listSources } from "../data/sources";
import { requestSync, type RequestOutcome } from "../data/sync-runs";
import { database } from "../db";
import { enabledEpicEnvironment, secrets } from "../env";
import { requireUser, type AppEnv } from "../session";
import { sendTo } from "../sync-queue";

// The connections page's reads and actions (src/app/(app)/app/connections in the Next app):
// search, refresh, disconnect and delete. Answers with outcomes; the web Worker redirects.
export const connectionRoutes = new Hono<AppEnv>();
connectionRoutes.use("/connections/*", requireUser("json"));
connectionRoutes.use("/sources/*", requireUser("json"));

// Health systems to connect to: the stored directory, or Epic's R4 list before the first import.
connectionRoutes.get("/connections/choices", async (c) => {
  const choices = await connectChoices(database(c.env.DB), enabledEpicEnvironment(secrets(c.env)), c.req.query("q") ?? "", new Set()).catch(() => null);
  return c.json({ choices }, 200, { "Cache-Control": "no-store" });
});

// Removes the tokens. Records already imported stay until the person deletes them.
connectionRoutes.post("/connections/:id/disconnect", async (c) => c.json({ disconnected: await disconnect(c.get("scope"), c.req.param("id"), new Date()) }));

// Checks every connected organization for new records: one outcome for the lot, queued if any
// started, otherwise the most telling reason.
connectionRoutes.post("/sources/refresh", async (c) => {
  const scope = c.get("scope");
  const sources = (await listSources(scope)).filter((s) => s.status === "connected");
  const outcomes = await Promise.all(
    sources.map((s) =>
      requestSync(scope, { sourceId: s.id, trigger: "manual" }, sendTo(c.env), new Date()).catch((error: unknown) => {
        console.error("[sync] queueing failed", error instanceof Error ? error.name : "unknown");
        return "failed" as const;
      }),
    ),
  );
  const outcome = (["queued", "already_running", "cooldown", "failed"] as const).find((o) => (outcomes as string[]).includes(o)) ?? "not_connected";
  return c.json({ outcome });
});

connectionRoutes.post("/sources/:id/refresh", async (c) => {
  let outcome: RequestOutcome | "failed";
  try {
    outcome = await requestSync(c.get("scope"), { sourceId: c.req.param("id"), trigger: "manual" }, sendTo(c.env), new Date());
  } catch (error) {
    console.error("[sync] queueing failed", error instanceof Error ? error.name : "unknown");
    outcome = "failed";
  }
  return c.json({ outcome });
});

// Deletes the organization and everything stored from it: records, sync history and tokens.
connectionRoutes.delete("/sources/:id", async (c) => c.json({ deleted: await deleteSource(c.get("scope"), c.req.param("id"), new Date()) }));
