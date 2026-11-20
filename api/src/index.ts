import { app } from "./app";
import { ensureDemoChart } from "./data/demo";
import { database } from "./db";
import { secrets, type Bindings } from "./env";
import { recordsKey } from "./epic/credentials";

export { TokenRefresher } from "./epic/token-refresher";
export { UserLock } from "./locks";
export { RateLimiter } from "./limits";
export { DirectoryImportWorkflow, RefreshSourcesWorkflow, SyncSourceWorkflow } from "./jobs/workflows";

// demoChart: just after midnight Pacific, re-dates the demo chart to the new day.
export const CRONS = { refreshSources: "17 10 * * *", epicDirectory: "41 8 * * *", demoChart: "5 8 * * *" } as const;

// Starts a Workflow once per id: a cron retried by Cloudflare finds the day's instance and stops.
async function startOnce(workflow: Workflow, id: string): Promise<void> {
  try {
    await workflow.create({ id });
  } catch (error) {
    const existing = await workflow.get(id).catch(() => undefined);
    if (!existing) throw error;
  }
}

export default {
  fetch: app.fetch,
  // Cron Triggers (wrangler.jsonc), replacing the Inngest crons.
  async scheduled(controller, env) {
    const day = new Date(controller.scheduledTime).toISOString().slice(0, 10);
    if (controller.cron === CRONS.refreshSources) await startOnce(env.REFRESH_WORKFLOW, `refresh-sources-${day}`);
    else if (controller.cron === CRONS.epicDirectory) await startOnce(env.DIRECTORY_WORKFLOW, `epic-directory-${day}`);
    else if (controller.cron === CRONS.demoChart) await ensureDemoChart(env, database(env.DB), recordsKey(secrets(env)), new Date(controller.scheduledTime));
  },
} satisfies ExportedHandler<Bindings>;
