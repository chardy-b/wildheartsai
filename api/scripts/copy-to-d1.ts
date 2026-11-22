// Copies production's rows from Neon (Postgres) to D1 for the cutover (Phase 7 of
// docs/superpowers/plans/2026-10-30-cloudflare-migration.md; runbook in
// docs/superpowers/plans/2026-11-20-cutover-runbook.md). Run from the repository root:
//
//   DATABASE_URL=<postgres> npx tsx api/scripts/copy-to-d1.ts export --out <dir>
//   npx tsx api/scripts/copy-to-d1.ts import --dir <dir> --target local|rehearsal|preview|production
//   RECORDS_ENCRYPTION_KEY=<key> TOKEN_ENCRYPTION_KEY=<key> npx tsx api/scripts/copy-to-d1.ts verify --dir <dir> --target ...
//
// What it never does: unseal anything during the copy (sealed columns are copied byte for byte),
// print row contents, or write outside <dir>. It logs table names and counts only. The export
// directory holds health data in sealed form: keep it on the operator's machine and delete it
// right after the import is verified. Never commit it.
//
// - Types follow the D1 schema (api/src/db/schema): timestamps to epoch milliseconds (Postgres
//   `timestamp` read as UTC), booleans to 0/1, JSON to text, bigint to numbers.
// - Tables go in foreign-key order. A column referencing its own table (fhir_resource
//   superseded_by, session parent_session_id) is filled in by UPDATEs after the table's rows.
// - D1 takes at most 100 KB per statement, so larger values go in as appends of 40 KB pieces.
// - Not copied: the Epic directory (public, rebuilt by its import job after the cutover), Better
//   Auth's rate-limit counters and sessions (everyone signs in again: see SKIP), chat (it never ran
//   in production), and every demo identity's rows (the demo chart is written fresh on Cloudflare,
//   and has no login there).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable, type SQLiteColumn } from "drizzle-orm/sqlite-core";
import pg from "pg";
import { isDemoIdentity } from "../../src/lib/demo/identity";
import { keysFrom, unsealField } from "../src/crypto/fields";
import { unseal } from "../src/crypto/seal";
import * as schema from "../src/db/schema";

// session: production on Cloudflare gets a new BETTER_AUTH_SECRET (owner decision, 2026-11-22), so
// cookies signed with the old one can't be used; copying their tokens would only move dead credentials.
const SKIP = new Set(["epic_directory_entry", "epic_directory_import", "rate_limit", "session"]);
// The token key roll (src/lib/crypto/token-keys.ts, on main): Vercel's TOKEN_ENCRYPTION_KEY can't
// be read back, so connection credentials are also sealed under a new key in `_next` columns, and
// D1 takes those. Cloudflare's TOKEN_ENCRYPTION_KEY is the new key. A connection not yet fully
// re-sealed stops the export: run the reseal job on Vercel first.
const ROLLED: Record<string, Record<string, string>> = {
  epic_connection: { sealed_patient_id: "sealed_patient_id_next", sealed_access_token: "sealed_access_token_next", sealed_refresh_token: "sealed_refresh_token_next" },
  metriport_connection: { sealed_patient_id: "sealed_patient_id_next" },
};
const STATEMENT_LIMIT = 90_000;
const PIECE = 40_000;
const FILE_LIMIT = 4 * 1024 * 1024;
const PAGE = 1000;

type Table = { name: string; columns: SQLiteColumn[]; pk: string[]; selfRefs: string[]; deps: string[] };
type Manifest = { createdAt: string; tables: Record<string, { rows: number; checksum: string }>; files: string[] };

function tables(): Table[] {
  const all = (Object.values(schema).filter((v) => is(v, SQLiteTable)) as SQLiteTable[]).map((t) => {
    const config = getTableConfig(t);
    const refs = config.foreignKeys.map((f) => f.reference());
    const deps = refs.map((r) => getTableConfig(r.foreignTable).name).filter((n) => n !== config.name);
    const selfRefs = refs.filter((r) => getTableConfig(r.foreignTable).name === config.name).flatMap((r) => r.columns.map((c) => c.name));
    const pk = config.columns.filter((c) => c.primary).map((c) => c.name);
    return { name: config.name, columns: config.columns, pk: pk.length ? pk : config.primaryKeys[0].columns.map((c) => c.name), selfRefs, deps };
  }).filter((t) => !SKIP.has(t.name));
  // Foreign-key order.
  const ordered: Table[] = [];
  const remaining = new Map(all.map((t) => [t.name, t]));
  while (remaining.size) {
    const ready = [...remaining.values()].filter((t) => t.deps.every((d) => !remaining.has(d)));
    if (!ready.length) throw new Error(`foreign-key cycle among ${[...remaining.keys()].join(", ")}`);
    for (const t of ready.sort((a, b) => a.name.localeCompare(b.name))) { ordered.push(t); remaining.delete(t.name); }
  }
  return ordered;
}

// A Postgres value as D1 stores it in that column.
function convert(column: SQLiteColumn, value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  switch (column.columnType) {
    case "SQLiteTimestamp": {
      const ms = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
      if (!Number.isFinite(ms)) throw new Error(`bad timestamp in ${column.name}`);
      return ms;
    }
    case "SQLiteBoolean": return value ? 1 : 0;
    case "SQLiteTextJson": return JSON.stringify(value);
    case "SQLiteInteger": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isSafeInteger(n)) throw new Error(`bad integer in ${column.name}`);
      return n;
    }
    default:
      if (typeof value === "object") return JSON.stringify(value);
      return typeof value === "number" ? value : String(value);
  }
}

const literal = (value: string | number | null) => (value === null ? "NULL" : typeof value === "number" ? String(value) : `'${value.replace(/'/g, "''")}'`);
const quoted = (name: string) => `"${name}"`;
const rowHash = (values: (string | number | null)[]) => createHash("sha256").update(JSON.stringify(values)).digest("hex");
// Independent of row order (Postgres and SQLite sort text differently).
const tableChecksum = (hashes: string[]) => createHash("sha256").update(hashes.sort().join("\n")).digest("hex");

function statements(table: Table, values: (string | number | null)[]): string[] {
  const names = table.columns.map((c) => c.name);
  const where = table.pk.map((k) => `${quoted(k)} = ${literal(values[names.indexOf(k)])}`).join(" and ");
  const deferred: string[] = [];
  const first = values.map((value, i) => {
    if (table.selfRefs.includes(names[i]) && value !== null) {
      deferred.push(`UPDATE ${quoted(table.name)} SET ${quoted(names[i])} = ${literal(value)} WHERE ${where};`);
      return null;
    }
    return value;
  });
  const insert = (vals: (string | number | null)[]) => `INSERT INTO ${quoted(table.name)} (${names.map(quoted).join(", ")}) VALUES (${vals.map(literal).join(", ")});`;
  const plain = insert(first);
  if (Buffer.byteLength(plain) <= STATEMENT_LIMIT) return [plain, ...deferred.map((s) => `-- self:${s}`)];
  // Too long for one statement: large text goes in as appends.
  const appends: string[] = [];
  const small = first.map((value, i) => {
    if (typeof value === "string" && value.length > PIECE) {
      for (let at = 0; at < value.length; at += PIECE) appends.push(`UPDATE ${quoted(table.name)} SET ${quoted(names[i])} = ${quoted(names[i])} || ${literal(value.slice(at, at + PIECE))} WHERE ${where};`);
      return "";
    }
    return value;
  });
  return [insert(small), ...appends, ...deferred.map((s) => `-- self:${s}`)];
}

async function exportNeon(out: string) {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL (or DATABASE_URL_UNPOOLED) to the Postgres database to copy.");
  // `timestamp` (no time zone) as text, read as UTC; `timestamptz` keeps its offset.
  pg.types.setTypeParser(1114, (v) => new Date(`${v.replace(" ", "T")}Z`));
  pg.types.setTypeParser(1184, (v) => new Date(v));
  pg.types.setTypeParser(20, (v) => Number(v));
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("begin isolation level repeatable read read only");
  // Before writing anything: every connection must be re-sealed under the new token key.
  const { rows: [pending] } = await client.query(`SELECT
    (SELECT count(*) FROM epic_connection WHERE sealed_patient_id_next IS NULL OR sealed_access_token_next IS NULL OR (sealed_refresh_token IS NOT NULL AND sealed_refresh_token_next IS NULL))
    + (SELECT count(*) FROM metriport_connection WHERE sealed_patient_id_next IS NULL) AS n`);
  if (Number(pending.n) > 0) {
    await client.query("rollback");
    await client.end();
    throw new Error(`${pending.n} connection(s) aren't re-sealed under the new token key. Send connections/tokens.reseal-requested on Vercel, check it reports incomplete: 0, and export again.`);
  }
  mkdirSync(out, { recursive: true });
  const manifest: Manifest = { createdAt: new Date().toISOString(), tables: {}, files: [] };
  let file: string[] = [], size = 0;
  const flush = () => {
    if (!file.length) return;
    const name = `${String(manifest.files.length + 1).padStart(4, "0")}.sql`;
    writeFileSync(join(out, name), `PRAGMA defer_foreign_keys = true;\n${file.join("\n")}\n`, { mode: 0o600 });
    manifest.files.push(name);
    file = [];
    size = 0;
  };
  const write = (line: string) => {
    if (size + line.length > FILE_LIMIT) flush();
    file.push(line);
    size += line.length + 1;
  };
  const demoSources = new Set<string>();
  let unrolled = 0;
  try {
    for (const table of tables()) {
      const names = table.columns.map((c) => c.name);
      const hashes: string[] = [];
      const selfUpdates: string[] = [];
      const order = table.pk.map(quoted).join(", ");
      let last: unknown[] | null = null;
      for (;;) {
        const after = last ? `WHERE (${order}) > (${last.map((_, i) => `$${i + 1}`).join(", ")})` : "";
        const rolled = ROLLED[table.name] ?? {};
        const extra = Object.values(rolled);
        const { rows } = await client.query(`SELECT ${[...names, ...extra].map(quoted).join(", ")} FROM ${quoted(table.name)} ${after} ORDER BY ${order} LIMIT ${PAGE}`, last ?? []);
        for (const row of rows as Record<string, unknown>[]) {
          // Demo identities aren't copied (see the header).
          const owner = (row.user_id ?? (table.name === "user" ? row.id : undefined)) as string | undefined;
          if (owner && isDemoIdentity(owner)) {
            if (table.name === "health_source") demoSources.add(row.id as string);
            continue;
          }
          if (table.name === "sync_cursor" && demoSources.has(row.source_id as string)) continue;
          // Credentials under the new key, never the old: a missing one stops the export.
          for (const [column, next] of Object.entries(rolled)) {
            if (row[column] !== null && row[next] === null) {
              unrolled++;
              continue;
            }
            row[column] = row[next];
          }
          const values = table.columns.map((c) => convert(c, row[c.name]));
          hashes.push(rowHash(values));
          for (const s of statements(table, values)) {
            if (s.startsWith("-- self:")) selfUpdates.push(s.slice(8));
            else write(s);
          }
        }
        if (rows.length < PAGE) break;
        const tail = rows[rows.length - 1] as Record<string, unknown>;
        last = table.pk.map((k) => tail[k]);
      }
      for (const s of selfUpdates) write(s);
      manifest.tables[table.name] = { rows: hashes.length, checksum: tableChecksum(hashes) };
      console.log(`${table.name}: ${hashes.length}`);
    }
    if (unrolled) throw new Error(`${unrolled} connection credential(s) aren't sealed under the new token key yet. Send connections/tokens.reseal-requested on Vercel, check it reports incomplete: 0, and export again.`);
    flush();
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  console.log(`Wrote ${manifest.files.length} files to ${out}. Delete the directory once the import is verified.`);
}

// `wrangler d1 execute` against the target's main database.
function wrangler(target: string, args: string[]): string {
  const where = target === "local" ? ["--local", "--persist-to", ".wrangler/state"] : ["--remote", "--env", target];
  if (!["local", "rehearsal", "preview", "production"].includes(target)) throw new Error("--target is local, rehearsal, preview or production");
  // Wrangler's own output (warnings, progress) stays out of the log; a failure still shows it.
  return execFileSync("npx", ["wrangler", "d1", "execute", "DB", "-c", "api/wrangler.jsonc", ...where, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
}

function query<T>(target: string, sql: string): T[] {
  const out = wrangler(target, ["--json", "--command", sql]);
  return (JSON.parse(out.slice(out.indexOf("["))) as { results: T[] }[])[0].results;
}

function importD1(dir: string, target: string) {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  const existing = query<{ n: number }>(target, `SELECT count(*) AS n FROM "user"`)[0].n;
  if (existing > 0) throw new Error(`The ${target} database already has ${existing} users. Import into an empty, migrated database.`);
  const started = Date.now();
  for (const [i, file] of manifest.files.entries()) {
    wrangler(target, ["--yes", "--file", join(dir, file)]);
    console.log(`imported ${i + 1}/${manifest.files.length}`);
  }
  console.log(`Import took ${Math.round((Date.now() - started) / 1000)} s. Now run verify.`);
}

async function verify(dir: string, target: string) {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  let failures = 0;
  for (const table of tables()) {
    const expected = manifest.tables[table.name];
    const names = table.columns.map((c) => c.name);
    const hashes: string[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const rows = query<Record<string, string | number | null>>(target, `SELECT ${names.map(quoted).join(", ")} FROM ${quoted(table.name)} ORDER BY ${table.pk.map(quoted).join(", ")} LIMIT ${PAGE} OFFSET ${offset}`);
      for (const row of rows) hashes.push(rowHash(names.map((n) => row[n] ?? null)));
      if (rows.length < PAGE) break;
    }
    const ok = hashes.length === expected.rows && tableChecksum(hashes) === expected.checksum;
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${table.name}: ${hashes.length} of ${expected.rows}${ok ? "" : hashes.length === expected.rows ? " (checksum differs)" : ""}`);
  }
  // Sealed values still open with the keys the Workers will use. Counts only.
  const recordsKey = process.env.RECORDS_ENCRYPTION_KEY, tokenKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (!recordsKey || !tokenKey) {
    console.log("Skipped the decrypt sample: set RECORDS_ENCRYPTION_KEY and TOKEN_ENCRYPTION_KEY (the Workers' values) to run it.");
  } else {
    const kek = Buffer.from(recordsKey, "base64"), tokens = Buffer.from(tokenKey, "base64");
    const sample = query<{ user_id: string; sealed_dek: string; kek_version: number; id: string | null; sealed_summary: string | null }>(target,
      `SELECT k.user_id, k.sealed_dek, k.kek_version, r.id, r.sealed_summary FROM user_data_key k LEFT JOIN fhir_resource r ON r.id = (SELECT id FROM fhir_resource WHERE user_id = k.user_id LIMIT 1) ORDER BY random() LIMIT 50`);
    let opened = 0, failed = 0;
    for (const row of sample) {
      try {
        const keys = keysFrom(row.user_id, row.sealed_dek, kek, row.kek_version);
        if (row.id && row.sealed_summary) JSON.parse(unsealField(keys, row.sealed_summary, { table: "fhir_resource", field: "summary", rowId: row.id }));
        opened++;
      } catch {
        failed++;
      }
    }
    const connections = query<{ sealed_access_token: string }>(target, "SELECT sealed_access_token FROM epic_connection ORDER BY random() LIMIT 20");
    let tokensOpened = 0;
    for (const row of connections) {
      try { unseal(row.sealed_access_token, tokens); tokensOpened++; } catch { failed++; }
    }
    failures += failed;
    console.log(`${failed ? "FAIL" : "ok  "} decrypt sample: ${opened} of ${sample.length} people's keys and records, ${tokensOpened} of ${connections.length} Epic tokens`);
  }
  console.log(failures ? `${failures} check(s) failed.` : "All checks passed.");
  if (failures) process.exitCode = 1;
}

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const at = rest.indexOf(`--${name}`);
  if (at < 0 || !rest[at + 1]) throw new Error(`--${name} is required`);
  return rest[at + 1];
};
if (command === "export") await exportNeon(flag("out"));
else if (command === "import") importD1(flag("dir"), flag("target"));
else if (command === "verify") await verify(flag("dir"), flag("target"));
else {
  console.error("Usage: copy-to-d1.ts export --out <dir> | import --dir <dir> --target <t> | verify --dir <dir> --target <t>");
  process.exitCode = 2;
}
