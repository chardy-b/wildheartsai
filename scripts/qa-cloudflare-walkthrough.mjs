// Walks through the app on the Cloudflare stack, in a real browser: sign-up, the email link,
// onboarding (server actions), the dashboard and records pages, refresh and delete (server actions
// that reach the API and start a sync Workflow), and the export. Made-up account and data only.
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

  console.log(problems.length ? `problems:\n${problems.join("\n")}` : "no console or page errors");
  await browser.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
