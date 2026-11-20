// Walks through the app on the Cloudflare stack, in a real browser: sign-up, the email link,
// onboarding (server actions), the dashboard and records pages, refresh and delete (server actions
// that reach the API and start a sync Workflow), the export, and the guided demo. Made-up account
// and data only.
//
// Run it against the local stack (see api/README.md, "The whole stack on Cloudflare, locally"):
//   npm run cf:build && npm run cf:migrate:local
//   npm run cf:preview > .wrangler/cf-preview.log 2>&1 &
//   node scripts/qa-cloudflare-walkthrough.mjs .wrangler/cf-preview.log
// The log argument is where the API prints verification links locally (src/auth/email.ts).
// Needs Playwright with Chromium (preinstalled in Claude Code's cloud sessions).
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Through CommonJS resolution, which finds a globally installed Playwright.
const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = "http://localhost:8787";
const LOG = process.argv[2];
const email = `walkthrough-${Date.now()}@example.test`;
const step = (name) => console.log(`✓ ${name}`);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const problems = [];
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text().slice(0, 200)}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message.slice(0, 200)}`));

  await page.goto(`${BASE}/sign-up`);
  await page.fill('input[name="name"]', "Sam");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "made-up-walkthrough-password");
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE}/check-email`);
  step("signed up, sent to check-email");

  let link;
  for (let i = 0; i < 20 && !link; i++) {
    const found = readFileSync(LOG, "utf8").match(/http:\/\/localhost:8787\/api\/auth\/verify-email\?\S+/g);
    link = found ? found[found.length - 1] : undefined;
    if (!link) await new Promise((r) => setTimeout(r, 500));
  }
  if (!link) throw new Error("no verification link in the API's log");
  await page.goto(link);
  await page.waitForURL(/\/app\/onboarding/);
  step("verified by email link, signed in, onboarding shown");

  await page.fill('input[name="preferredName"]', "Sam");
  await page.click('button[type="submit"]');
  await page.waitForSelector('input[type="checkbox"]');
  step("name saved (server action -> API)");

  for (const box of await page.$$('input[type="checkbox"]')) await box.check();
  await page.click('button[type="submit"]');
  await page.waitForSelector("text=Epic sandbox");
  step("acknowledged; connect step lists the Epic sandbox (choices from the API)");

  await page.click("button:has-text('do this later')");
  await page.waitForURL(`${BASE}/app`);
  await page.waitForSelector("text=Welcome, Sam.");
  step("finished onboarding; dashboard says 'Welcome, Sam.'");

  await page.goto(`${BASE}/app/connections`);
  await page.waitForSelector("h1:has-text('Connections')");
  step("connections page rendered");
  const refreshAll = await page.$("button:has-text('Refresh all')");
  if (refreshAll) {
    await refreshAll.click();
    await page.waitForURL(/refresh=/);
    step(`refresh all -> ${new URL(page.url()).search}`);
  }

  const download = await page.request.get(`${BASE}/app/export`);
  const bundle = await download.json();
  if (bundle.resourceType !== "Bundle") throw new Error("export is not a Bundle");
  step(`export: ${download.headers()["content-disposition"]}`);

  const session = await page.request.get(`${BASE}/api/session`);
  const body = await session.json();
  step(`/api/session -> ${session.status()}, same person: ${body.user && body.user.email === email}`);

  // A connected source, written straight to the local database (Epic's sign-in needs a person).
  const sourceId = randomUUID();
  execSync(
    `npx wrangler d1 execute DB --local -c api/wrangler.jsonc --persist-to .wrangler/state --command "insert into health_source (id, user_id, vendor, fhir_base_url, organization_name, status) values ('${sourceId}', '${body.user.id}', 'epic', 'https://fhir.example.test/api/FHIR/R4', 'Made-up Health', 'connected')"`,
    { stdio: "ignore", env: { ...process.env, CI: "1" } },
  );
  await page.goto(`${BASE}/app?view=records`);
  await page.waitForSelector("text=No records yet.");
  step("dashboard with a source: timeline from the API (no records yet)");
  await page.goto(`${BASE}/app/records/labs`);
  await page.waitForSelector("h1");
  step(`records page: ${(await page.textContent("h1")).trim()}`);
  await page.goto(`${BASE}/app/connections`);
  await page.waitForSelector("text=Made-up Health");
  await page.click(".connection-actions button:has-text('Refresh')");
  await page.waitForURL(/refresh=/);
  step(`refresh (server action -> API -> sync Workflow) -> ${new URL(page.url()).search}`);
  await page.click("summary:has-text('Delete records')");
  await page.click("button:has-text('Delete records from Made-up Health')");
  await page.waitForURL(/deleted=1/);
  await page.waitForSelector("text=Deleted. Records from that health system are no longer stored.");
  step("deleted the source (server action -> API)");

  // Documents: one made-up text file through the API, then the pages that list it.
  const uploaded = await page.request.post(`${BASE}/api/wildcards`, { data: Buffer.from("A made-up note for the walkthrough."), headers: { "Content-Type": "application/octet-stream", "x-file-name": "walkthrough-note.txt", Origin: BASE } });
  if (uploaded.status() !== 201) throw new Error(`upload answered ${uploaded.status()}`);
  await page.goto(`${BASE}/app/wildcards`);
  await page.waitForSelector("text=walkthrough-note.txt");
  step("documents: uploaded to R2 through the API and listed on the page");
  await page.goto(`${BASE}/app/wildcards/progress`);
  await page.waitForSelector("h1:has-text('Document processing')");
  await page.goto(`${BASE}/app/wildcards/workbench`);
  await page.waitForSelector("h1:has-text('Extraction workbench')");
  step("extraction progress and workbench pages rendered");

  // The guided demo (needs DEMO_ENABLED=1 on both Workers; on in local development).
  await page.goto(`${BASE}/demo`);
  await page.click("button:has-text('Open guided demo')");
  await page.waitForURL(`${BASE}/app/demo`);
  await page.waitForSelector("text=43 stored records");
  step("opened the guided demo (server action -> API), the central chart: 43 fictional records");
  await page.click("button:has-text('Next chapter')");
  await page.click("button:has-text('Replay sample sync')");
  await page.waitForSelector("button:has-text('Replay sample sync'):not([disabled])");
  await page.waitForSelector("text=43 stored records");
  step("replayed the sample sync from the browser (/api/demo/sync), nothing duplicated");
  const demoSession = await (await page.request.get(`${BASE}/api/session`)).json();
  if (demoSession.user.id === body.user.id) throw new Error("the demo cookie didn't select the workspace");
  await page.click("button:has-text('Return to my account')");
  await page.waitForURL(`${BASE}/app`);
  await page.waitForSelector("text=Welcome, Sam.");
  const back = await (await page.request.get(`${BASE}/api/session`)).json();
  step(`left the demo: back to the real account (${back.user.id === body.user.id})`);

  // A visitor without an account: the public guest demo, in a fresh browser context.
  const visitor = await (await browser.newContext()).newPage();
  visitor.on("pageerror", (e) => problems.push(`guest pageerror: ${e.message.slice(0, 200)}`));
  await visitor.goto(`${BASE}/demo`);
  await visitor.click("button:has-text('Open guided demo')");
  await visitor.waitForURL(`${BASE}/app/demo`);
  await visitor.waitForSelector("text=43 stored records");
  step("guest: opened the demo without an account, the same central chart");
  await visitor.goto(`${BASE}/app?view=records`);
  await visitor.waitForSelector("text=fictional demo");
  step("guest: the record timeline shows the fictional chart");
  await visitor.click("button:has-text('Leave demo')");
  await visitor.waitForURL(`${BASE}/demo`);
  const after = await visitor.request.get(`${BASE}/api/session`);
  step(`guest: left the demo, nothing was stored (session now ${after.status()})`);

  console.log(problems.length ? `problems:\n${problems.join("\n")}` : "no console or page errors");
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
