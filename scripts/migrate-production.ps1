# Applies pending drizzle/ migrations to the PRODUCTION database, then checks they landed.
#
#   pwsh scripts/migrate-production.ps1
#
# Paste production's DATABASE_URL_UNPOOLED when asked: Vercel -> wildheartsai -> Settings ->
# Environment Variables, filtered to Production. The URL is never printed or saved; it is only
# set for this script's child processes and cleared at the end.

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$secure = Read-Host "Production DATABASE_URL_UNPOOLED" -AsSecureString
$url = [System.Net.NetworkCredential]::new("", $secure).Password.Trim().Trim('"')
if (-not $url) { throw "No URL entered." }

try { $uri = [Uri]$url } catch { throw "That isn't a valid postgres URL." }
if ($uri.Scheme -notin @("postgres", "postgresql")) { throw "Expected a postgres:// URL." }
if ($uri.Host -in @("localhost", "127.0.0.1", "::1")) { throw "That's the local database, not production." }
if ($uri.Host -like "*-pooler*") {
  Write-Warning "This is the pooled URL. Use DATABASE_URL_UNPOOLED (no '-pooler' in the host) for migrations."
  if ((Read-Host "Continue anyway? (y/N)") -ne "y") { exit 1 }
}

Write-Host ""
Write-Host "Database host: $($uri.Host)"
Write-Host "Database name: $($uri.AbsolutePath.TrimStart('/'))"
Write-Host "Compare the host with PGHOST_UNPOOLED in Vercel's Production scope."
if ((Read-Host "Apply migrations to this database? (y/N)") -ne "y") { exit 1 }

$env:DATABASE_URL = $url
try {
  Write-Host "`nApplying migrations..."
  npx drizzle-kit migrate
  if ($LASTEXITCODE -ne 0) { throw "drizzle-kit migrate failed (exit $LASTEXITCODE). Nothing below was checked." }

  Write-Host "`nChecking the database..."
  node -e @'
const { Client } = require("pg");
(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const tables = ["health_source", "fhir_resource", "sync_run", "user_data_key"];
  const { rows } = await client.query("select table_name from information_schema.tables where table_schema = 'public' and table_name = any($1)", [tables]);
  const found = new Set(rows.map((r) => r.table_name));
  const migrations = await client.query("select count(*)::int as n from drizzle.__drizzle_migrations");
  const linked = await client.query("select count(*)::int as n from epic_connection where source_id is null");
  await client.end();
  for (const t of tables) console.log(`  ${found.has(t) ? "ok     " : "MISSING"} ${t}`);
  console.log(`  migrations recorded: ${migrations.rows[0].n}`);
  console.log(`  connections without a source: ${linked.rows[0].n}`);
  process.exit(tables.every((t) => found.has(t)) && linked.rows[0].n === 0 ? 0 : 1);
})().catch((e) => { console.error("  check failed:", e.message); process.exit(1); });
'@
  if ($LASTEXITCODE -ne 0) { throw "The database doesn't look fully migrated. See above." }
  Write-Host "`nDone. Reload https://www.wildheartsai.com/app"
}
finally {
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
}
