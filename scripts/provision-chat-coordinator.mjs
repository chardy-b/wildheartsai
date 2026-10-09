// Operator-only: inject secrets from a trusted secret manager, never command arguments.
// Requires the owner connection, not either restricted chat connection. No secret output.
import { createHash } from "node:crypto";
import { Pool } from "pg";

async function main() {
  const connectionString = process.env.DATABASE_URL_UNPOOLED;
  const credential = process.env.CHAT_COORDINATOR_CREDENTIAL;
  const replaceId = process.env.CHAT_COORDINATOR_REPLACE_ID;
  if (!connectionString || !credential || !/^[A-Za-z0-9_-]{43,128}$/.test(credential)) throw new Error("configuration_invalid");
  if (replaceId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(replaceId)) throw new Error("configuration_invalid");
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
  pool.on("error", () => {});
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const hash = createHash("sha256").update(credential).digest("hex");
      const result = await client.query("INSERT INTO public.chat_coordinator (credential_hash) VALUES ($1) ON CONFLICT (credential_hash) DO NOTHING RETURNING id", [hash]);
      const current = result.rows[0] ?? (await client.query("SELECT id, disabled_at FROM public.chat_coordinator WHERE credential_hash=$1 FOR UPDATE", [hash])).rows[0];
      if (!current || current.disabled_at || current.id === replaceId) throw new Error("credential_reuse_invalid");
      if (replaceId) {
        const previous = await client.query("SELECT id FROM public.chat_coordinator WHERE id=$1 FOR UPDATE", [replaceId]);
        if (!previous.rowCount) throw new Error("coordinator_not_found");
        await client.query("UPDATE public.chat_coordinator SET disabled_at=clock_timestamp() WHERE id=$1", [replaceId]);
        await client.query("UPDATE public.chat_run SET status='interrupted', grants_revoked_at=clock_timestamp(), lease_owner=NULL, lease_expires_at=NULL, completed_at=clock_timestamp(), updated_at=clock_timestamp() WHERE coordinator_id=$1 AND status IN ('queued','running')", [replaceId]);
      }
      await client.query("COMMIT");
      console.info(`Coordinator ready: ${current.id}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  } finally { await pool.end(); }
}
main().catch(() => { console.error("Coordinator provisioning failed; no credentials or driver details printed."); process.exitCode = 1; });
