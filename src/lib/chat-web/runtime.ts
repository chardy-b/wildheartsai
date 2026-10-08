import "server-only";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { ChatAuthority } from "./authority";
import { assertChatDatabaseRoles } from "./role-preflight";

export class ChatUnavailableError extends Error {}
export function chatEnabled(): boolean { return process.env.CHAT_ENABLED === "1"; }
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new ChatUnavailableError("chat_unavailable");
  return value;
};

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
  const dataUrl = required("CHAT_DATABASE_URL");
  const queueUrl = required("CHAT_QUEUE_DATABASE_URL");
  const encodedKey = required("CHAT_GRANT_DERIVATION_KEY");
  const key = Buffer.from(encodedKey, "base64url");
  if (dataUrl === queueUrl || key.length < 32 || !/^[A-Za-z0-9_-]{43,128}$/.test(encodedKey) || key.toString("base64url") !== encodedKey) throw new ChatUnavailableError("chat_unavailable");
  required("RECORDS_ENCRYPTION_KEY");
  const modelId = required("CHAT_INFERENCE_MODEL");
  const dataPool = new Pool({ connectionString: dataUrl, max: 2, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 10_000, statement_timeout: 10_000 });
  const queuePool = new Pool({ connectionString: queueUrl, max: 2, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 10_000, statement_timeout: 10_000 });
  // pg evicts a failed idle connection; handle that event without logging credentials.
  dataPool.on("error", () => {});
  queuePool.on("error", () => {});
  try {
    await assertChatDatabaseRoles(dataPool, queuePool);
    const dataDb = drizzle(dataPool, { schema }) as unknown as Db;
    const queueDb = drizzle(queuePool, { schema }) as unknown as Db;
    return { dataDb, queueDb, authority: new ChatAuthority({ dataDb, queueDb, grantKey: key, modelId, researchGatewayTokenHash: process.env.CHAT_RESEARCH_GATEWAY_TOKEN_HASH || undefined }) };
  } catch {
    await Promise.all([dataPool.end(), queuePool.end()]);
    throw new ChatUnavailableError("chat_unavailable");
  }
}
