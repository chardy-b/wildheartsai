import "server-only";

export type DiagnosticCode =
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

export class InitializationFailure extends Error {
  constructor(readonly diagnosticCode: DiagnosticCode) { super(diagnosticCode); }
}

function property(value: object, name: string): unknown {
  try { return Object.getOwnPropertyDescriptor(value, name)?.value; }
  catch { return undefined; }
}

export function diagnosticCode(error: unknown): DiagnosticCode {
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

