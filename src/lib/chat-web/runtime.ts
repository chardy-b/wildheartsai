import "server-only";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { ChatAuthority } from "./authority";
import { assertChatDatabaseRoles } from "./role-preflight";

export class ChatUnavailableError extends Error {}
export function chatEnabled(): boolean { return process.env.CHAT_ENABLED === "1"; }

type InitializationPhase = "validate_config" | "connect_role_preflight" | "construct_authority";
type DiagnosticCode =
  | "MISSING_CHAT_DATABASE_URL" | "MISSING_CHAT_QUEUE_DATABASE_URL" | "MISSING_CHAT_GRANT_DERIVATION_KEY"
  | "INVALID_CHAT_GRANT_DERIVATION_KEY" | "CHAT_DATABASE_URLS_MUST_DIFFER" | "MISSING_RECORDS_ENCRYPTION_KEY"
  | "MISSING_CHAT_INFERENCE_MODEL" | "CHAT_ROLES_NOT_RESTRICTED" | "CHAT_ROLE_HAS_MEMBERSHIPS"
  | "CHAT_ROLE_EXCESS_COLUMN_GRANT" | "CHAT_ROLE_MISSING_COLUMN_GRANT" | "CHAT_ROLE_EXCESS_TABLE_GRANT"
  | "CHAT_ROLE_MISSING_TABLE_GRANT" | "CHAT_RLS_NOT_ENABLED" | "CHAT_OWNER_POLICY_NOT_RESTRICTED"
  | "CHAT_RECORD_POLICY_NOT_RESTRICTED" | "CHAT_UNSCOPED_DATA_VISIBLE" | "QUEUE_RLS_NOT_ENABLED"
  | "QUEUE_POLICY_NOT_PROVISIONED" | "CHAT_SESSION_LOCK_NOT_RESTRICTED" | "QUEUE_ROLE_MUST_BE_SEPARATE"
  | "08000" | "08001" | "08003" | "08004" | "08006" | "08007" | "08P01" | "23502" | "23503"
  | "23505" | "23514" | "28P01" | "3D000" | "42501" | "42P01" | "42883" | "57P01" | "57P02"
  | "57P03" | "EACCES" | "ECONNREFUSED" | "ECONNRESET" | "EHOSTUNREACH" | "ENETUNREACH"
  | "ENOTFOUND" | "ENOENT" | "EPROTO" | "ETIMEDOUT" | "ERR_TLS_CERT_ALTNAME_INVALID" | "UNKNOWN";

const diagnosticCodes = new Set<DiagnosticCode>([
  "MISSING_CHAT_DATABASE_URL", "MISSING_CHAT_QUEUE_DATABASE_URL", "MISSING_CHAT_GRANT_DERIVATION_KEY",
  "INVALID_CHAT_GRANT_DERIVATION_KEY", "CHAT_DATABASE_URLS_MUST_DIFFER", "MISSING_RECORDS_ENCRYPTION_KEY",
  "MISSING_CHAT_INFERENCE_MODEL", "CHAT_ROLES_NOT_RESTRICTED", "CHAT_ROLE_HAS_MEMBERSHIPS",
  "CHAT_ROLE_EXCESS_COLUMN_GRANT", "CHAT_ROLE_MISSING_COLUMN_GRANT", "CHAT_ROLE_EXCESS_TABLE_GRANT",
  "CHAT_ROLE_MISSING_TABLE_GRANT", "CHAT_RLS_NOT_ENABLED", "CHAT_OWNER_POLICY_NOT_RESTRICTED",
  "CHAT_RECORD_POLICY_NOT_RESTRICTED", "CHAT_UNSCOPED_DATA_VISIBLE", "QUEUE_RLS_NOT_ENABLED",
  "QUEUE_POLICY_NOT_PROVISIONED", "CHAT_SESSION_LOCK_NOT_RESTRICTED", "QUEUE_ROLE_MUST_BE_SEPARATE",
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01", "23502", "23503", "23505",
  "23514", "28P01", "3D000", "42501", "42P01", "42883", "57P01", "57P02", "57P03", "EACCES",
  "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "ENOENT", "EPROTO",
  "ETIMEDOUT", "ERR_TLS_CERT_ALTNAME_INVALID", "UNKNOWN",
]);
const preflightMessages = new Map<string, DiagnosticCode>([
  ["chat_roles_not_restricted", "CHAT_ROLES_NOT_RESTRICTED"],
  ["chat_role_has_memberships", "CHAT_ROLE_HAS_MEMBERSHIPS"],
  ["chat_role_excess_column_grant", "CHAT_ROLE_EXCESS_COLUMN_GRANT"],
  ["chat_role_missing_column_grant", "CHAT_ROLE_MISSING_COLUMN_GRANT"],
  ["chat_role_excess_table_grant", "CHAT_ROLE_EXCESS_TABLE_GRANT"],
  ["chat_role_missing_table_grant", "CHAT_ROLE_MISSING_TABLE_GRANT"],
  ["chat_rls_not_enabled", "CHAT_RLS_NOT_ENABLED"],
  ["chat_owner_policy_not_restricted", "CHAT_OWNER_POLICY_NOT_RESTRICTED"],
  ["chat_record_policy_not_restricted", "CHAT_RECORD_POLICY_NOT_RESTRICTED"],
  ["chat_unscoped_data_visible", "CHAT_UNSCOPED_DATA_VISIBLE"],
  ["queue_rls_not_enabled", "QUEUE_RLS_NOT_ENABLED"],
  ["queue_policy_not_provisioned", "QUEUE_POLICY_NOT_PROVISIONED"],
  ["chat_session_lock_not_restricted", "CHAT_SESSION_LOCK_NOT_RESTRICTED"],
  ["queue_role_must_be_separate", "QUEUE_ROLE_MUST_BE_SEPARATE"],
]);

class InitializationFailure extends Error {
  constructor(readonly diagnosticCode: DiagnosticCode) { super(diagnosticCode); }
}

function required(name: "CHAT_DATABASE_URL" | "CHAT_QUEUE_DATABASE_URL" | "CHAT_GRANT_DERIVATION_KEY" | "RECORDS_ENCRYPTION_KEY" | "CHAT_INFERENCE_MODEL"): string {
  const value = process.env[name];
  if (value) return value;
  const codeByName: Record<typeof name, DiagnosticCode> = {
    CHAT_DATABASE_URL: "MISSING_CHAT_DATABASE_URL",
    CHAT_QUEUE_DATABASE_URL: "MISSING_CHAT_QUEUE_DATABASE_URL",
    CHAT_GRANT_DERIVATION_KEY: "MISSING_CHAT_GRANT_DERIVATION_KEY",
    RECORDS_ENCRYPTION_KEY: "MISSING_RECORDS_ENCRYPTION_KEY",
    CHAT_INFERENCE_MODEL: "MISSING_CHAT_INFERENCE_MODEL",
  };
  throw new InitializationFailure(codeByName[name]);
}

function property(value: object, name: string): unknown {
  try { return Object.getOwnPropertyDescriptor(value, name)?.value; }
  catch { return undefined; }
}

function diagnosticCode(error: unknown): DiagnosticCode {
  let current: unknown = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 6 && current && typeof current === "object" && !seen.has(current); depth += 1) {
    seen.add(current);
    if (current instanceof InitializationFailure && diagnosticCodes.has(current.diagnosticCode)) return current.diagnosticCode;
    const code = property(current, "code");
    if (typeof code === "string" && diagnosticCodes.has(code as DiagnosticCode) && code !== "UNKNOWN") return code as DiagnosticCode;
    const message = property(current, "message");
    if (typeof message === "string" && preflightMessages.has(message)) return preflightMessages.get(message)!;
    current = property(current, "cause");
  }
  return "UNKNOWN";
}

function reportInitializationFailure(phase: InitializationPhase, error: unknown): void {
  const code = diagnosticCode(error);
  console.error(`chat_runtime_initialization_failed phase=${phase} code=${code}`);
}

type WebChatRuntime = { dataDb: Db; queueDb: Db; authority: ChatAuthority };
let initialization: Promise<WebChatRuntime> | undefined;

/** No pools or secret lookups during module loading/build; each instance fails closed. */
export function webChatRuntime(): Promise<WebChatRuntime> {
  if (!chatEnabled()) return Promise.reject(new ChatUnavailableError("chat_unavailable"));
  initialization ??= initialize().catch(() => {
    initialization = undefined;
    throw new ChatUnavailableError("chat_unavailable");
  });
  return initialization;
}

async function initialize(): Promise<WebChatRuntime> {
  let phase: InitializationPhase = "validate_config";
  let dataPool: Pool | undefined;
  let queuePool: Pool | undefined;
  try {
    const dataUrl = required("CHAT_DATABASE_URL");
    const queueUrl = required("CHAT_QUEUE_DATABASE_URL");
    const encodedKey = required("CHAT_GRANT_DERIVATION_KEY");
    const key = Buffer.from(encodedKey, "base64url");
    if (dataUrl === queueUrl) throw new InitializationFailure("CHAT_DATABASE_URLS_MUST_DIFFER");
    if (key.length < 32 || !/^[A-Za-z0-9_-]{43,128}$/.test(encodedKey) || key.toString("base64url") !== encodedKey) {
      throw new InitializationFailure("INVALID_CHAT_GRANT_DERIVATION_KEY");
    }
    required("RECORDS_ENCRYPTION_KEY");
    const modelId = required("CHAT_INFERENCE_MODEL");

    phase = "connect_role_preflight";
    dataPool = new Pool({ connectionString: dataUrl, max: 2, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 10_000, statement_timeout: 10_000 });
    queuePool = new Pool({ connectionString: queueUrl, max: 2, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 10_000, statement_timeout: 10_000 });
    // pg evicts a failed idle connection; handle that event without logging credentials.
    dataPool.on("error", () => {});
    queuePool.on("error", () => {});
    await assertChatDatabaseRoles(dataPool, queuePool);

    phase = "construct_authority";
    const dataDb = drizzle(dataPool, { schema }) as unknown as Db;
    const queueDb = drizzle(queuePool, { schema }) as unknown as Db;
    return { dataDb, queueDb, authority: new ChatAuthority({ dataDb, queueDb, grantKey: key, modelId, researchGatewayTokenHash: process.env.CHAT_RESEARCH_GATEWAY_TOKEN_HASH || undefined }) };
  } catch (error) {
    reportInitializationFailure(phase, error);
    await Promise.allSettled([dataPool?.end(), queuePool?.end()].filter((end): end is Promise<void> => !!end));
    throw new ChatUnavailableError("chat_unavailable");
  }
}
