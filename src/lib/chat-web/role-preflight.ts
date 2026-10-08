/** Structural pg interface also permits the PostgreSQL implementation used by tests. */
export interface SqlClient { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
const chatTables = ["chat_conversation", "chat_message", "chat_run", "chat_tool_call", "chat_event", "user_summary", "summary_evidence"];
const recordTables = ["user_data_key", "health_source", "fhir_resource", "fhir_attachment"];
const queueSelect = new Set(["id", "user_id", "conversation_id", "status", "next_attempt_at", "lease_owner", "lease_expires_at", "cancellation_requested_at", "attempt", "created_at", "initiating_session_id", "coordinator_id", "claim_request_id", "granted_worker_id", "deadline_at", "execution_grant_hash", "control_grant_hash", "grants_revoked_at"]);
const queueUpdate = new Set(["status", "lease_owner", "lease_expires_at", "attempt", "next_worker_sequence", "started_at", "completed_at", "updated_at", "cancellation_requested_at", "coordinator_id", "claim_request_id", "granted_worker_id", "deadline_at", "execution_grant_hash", "control_grant_hash", "grants_revoked_at"]);
const coordinatorSelect = new Set(["id", "credential_hash", "disabled_at", "claim_window_at", "claim_count", "created_at"]);
const coordinatorUpdate = { data: new Set(["disabled_at"]), queue: new Set(["disabled_at", "claim_window_at", "claim_count"]) };
const authSelect: Record<string, Set<string>> = { session: new Set(["id", "user_id", "expires_at"]), user: new Set(["id", "email_verified"]) };
const keyInsert = new Set(["user_id", "sealed_dek", "kek_version", "created_at"]);

function ownerExpression(value: unknown): boolean {
  // Recognize exactly the migration's fail-closed owner predicate, not an expression
  // that happens to mention the setting while adding OR true or another bypass.
  return typeof value === "string" && value.replace(/[\s()]/g, "").replace(/::text/g, "") === "user_id=NULLIFcurrent_setting'app.user_id',true,''";
}

async function inspect(client: SqlClient, kind: "data" | "queue"): Promise<string> {
  const role = (await client.query("select current_user as name, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname=current_user")).rows[0];
  if (!role || role.rolsuper || role.rolbypassrls || role.rolcreaterole || role.rolcreatedb) throw new Error("chat_roles_not_restricted");
  const membership = await client.query("select 1 from pg_auth_members m join pg_roles r on r.oid=m.member where r.rolname=current_user limit 1");
  if (membership.rows.length) throw new Error("chat_role_has_memberships");
  const columns = (await client.query(`select c.relname as table_name, a.attname as column_name,
    has_column_privilege(current_user,c.oid,a.attnum,'SELECT') as read,
    has_column_privilege(current_user,c.oid,a.attnum,'INSERT') as insert,
    has_column_privilege(current_user,c.oid,a.attnum,'UPDATE') as update,
    has_column_privilege(current_user,c.oid,a.attnum,'REFERENCES') as references
    from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid
    where n.nspname='public' and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped`)).rows;
  for (const col of columns) {
    const table = String(col.table_name); const column = String(col.column_name);
    for (const privilege of ["read", "insert", "update", "references"] as const) {
      const allowed = table === "chat_coordinator" ? (privilege === "read" ? coordinatorSelect.has(column) : privilege === "update" && coordinatorUpdate[kind].has(column)) : kind === "queue" ? table === "chat_run" && (privilege === "read" ? queueSelect.has(column) : privilege === "update" && queueUpdate.has(column)) :
        privilege === "read" ? chatTables.includes(table) || recordTables.includes(table) || authSelect[table]?.has(column) === true :
        privilege === "insert" ? chatTables.includes(table) || table === "user_data_key" && keyInsert.has(column) : privilege === "update" && chatTables.includes(table);
      if (col[privilege] === true && !allowed) throw new Error("chat_role_excess_column_grant");
      // Every allowlisted privilege is used by the concrete adapter or its ORM selections.
      if (allowed && col[privilege] !== true) throw new Error("chat_role_missing_column_grant");
    }
  }
  const tables = (await client.query(`select c.relname as name, pg_get_userbyid(c.relowner)=current_user as owned,
    has_table_privilege(current_user,c.oid,'DELETE') as delete,
    has_table_privilege(current_user,c.oid,'TRUNCATE') as truncate,
    has_table_privilege(current_user,c.oid,'TRIGGER') as trigger
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')`)).rows;
  for (const table of tables) {
    if (table.owned || table.truncate || table.trigger || table.delete === true && !(kind === "data" && chatTables.includes(String(table.name)))) throw new Error("chat_role_excess_table_grant");
    if (kind === "data" && chatTables.includes(String(table.name)) && !table.delete) throw new Error("chat_role_missing_table_grant");
  }
  if (kind === "data") {
    const protectedTables = [...chatTables, ...recordTables];
    const rls = (await client.query("select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace='public'::regnamespace and relname=any($1::text[])", [protectedTables])).rows;
    if (rls.length !== protectedTables.length || rls.some((row) => !row.relrowsecurity || !row.relforcerowsecurity)) throw new Error("chat_rls_not_enabled");
    const policies = (await client.query("select tablename, permissive, cmd, qual, with_check from pg_policies where schemaname='public' and (roles::text[] @> array[current_user]::text[] or roles::text[] @> array['public']::text[])")).rows;
    for (const table of protectedTables) {
      const matching = policies.filter((p) => p.tablename === table);
      if (recordTables.includes(table)) {
        if (!matching.some((p) => p.permissive === "RESTRICTIVE" && p.cmd === "ALL" && ownerExpression(p.qual) && ownerExpression(p.with_check))) throw new Error("chat_record_policy_not_restricted");
      } else if (!matching.length || matching.some((p) => p.permissive === "PERMISSIVE" && (!ownerExpression(p.qual) || !ownerExpression(p.with_check)))) throw new Error("chat_owner_policy_not_restricted");
      // An unset or empty context must never expose personal rows, even through an
      // accidentally broadened policy. Run this on one transaction-local connection.
      const leaked = await client.query(`select exists(select 1 from public."${table}" limit 1) as leaked`);
      if (leaked.rows[0]?.leaked) throw new Error("chat_unscoped_data_visible");
    }
  } else {
    const rls = (await client.query("select relrowsecurity, relforcerowsecurity from pg_class where relnamespace='public'::regnamespace and relname='chat_run'")).rows[0];
    if (!rls?.relrowsecurity || !rls.relforcerowsecurity) throw new Error("queue_rls_not_enabled");
    const policies = (await client.query("select cmd, qual, with_check from pg_policies where schemaname='public' and tablename='chat_run' and permissive='PERMISSIVE' and roles::text[] @> array[current_user]::text[]")).rows;
    if (!policies.some((p) => p.cmd === "SELECT" && p.qual === "true") || !policies.some((p) => p.cmd === "UPDATE" && p.qual === "true" && p.with_check === "true")) throw new Error("queue_policy_not_provisioned");
  }
  const sessionLock = (await client.query(`select p.prosecdef, p.proconfig, p.prosrc as body, pg_get_userbyid(p.proowner) as owner,
    has_function_privilege(current_user,p.oid,'EXECUTE') as allowed,
    exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
    from pg_proc p where p.oid='public.chat_lock_session(text,text)'::regprocedure`)).rows[0];
  const expectedBody = `SELECT s.expires_at FROM public.session s JOIN public."user" u ON u.id=s.user_id
    WHERE s.id=p_session_id AND s.user_id=p_user_id AND s.expires_at > clock_timestamp()
      AND u.email_verified=true FOR SHARE OF s, u`;
  const normalize = (value: string) => value.replace(/\s+/g, "").toLowerCase();
  if (!sessionLock?.prosecdef || sessionLock.owner === role.name || !sessionLock.allowed || sessionLock.public_execute || !Array.isArray(sessionLock.proconfig) || !sessionLock.proconfig.includes("search_path=pg_catalog, public") || typeof sessionLock.body !== "string" || normalize(sessionLock.body) !== normalize(expectedBody)) throw new Error("chat_session_lock_not_restricted");
  return String(role.name);
}

/** Rejects deployments with stale grants, owner roles, role switching, or legacy permissive RLS. */
export async function assertChatDatabaseRoles(data: SqlClient, queue: SqlClient): Promise<void> {
  const [dataRole, queueRole] = await Promise.all([inspect(data, "data"), inspect(queue, "queue")]);
  if (dataRole === queueRole) throw new Error("queue_role_must_be_separate");
}
