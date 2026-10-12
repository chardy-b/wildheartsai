import "server-only";
import { diagnosticCode, InitializationFailure, type DiagnosticCode } from "./diagnostic-code";
import { logChatPoolFailure } from "./logging";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { ChatAuthority } from "./authority";
import { assertChatDatabaseRoles } from "./role-preflight";

export class ChatUnavailableError extends Error {}
export function chatEnabled(): boolean { return process.env.CHAT_ENABLED === "1"; }

type InitializationPhase = "validate_config" | "connect_role_preflight" | "construct_authority";
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
    dataPool.on("error", error => logChatPoolFailure("data", error));
    queuePool.on("error", error => logChatPoolFailure("queue", error));
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
