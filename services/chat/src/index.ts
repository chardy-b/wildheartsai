import { createChatHttpServer } from "./http.js";
import { createPrivateToolGateway } from "./private-gateway.js";
import { JwtCapabilityVerifier } from "./capabilities.js";
import type { ChatRepository } from "./contracts.js";
import { IggyRunDispatcher, type IggyControlPlane } from "./dispatcher.js";
import { createRuntime } from "./runtime.js";

type RuntimeAdapter = Readonly<{
  repository: ChatRepository;
  modelId: string;
  isSessionActive(sessionId: string, userId: string): Promise<boolean>;
  /** Checks the separately provisioned, least-privilege queue role before a worker may claim work. */
  assertQueueRoleReady(): Promise<void>;
  iggy?: IggyControlPlane;
  modelProxy?(input: { path: string; body: unknown; signal: AbortSignal }): Promise<Response>;
}>;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

async function main(): Promise<void> {
  const adapter: RuntimeAdapter = await createRuntime();
  // Both public and private listeners fail closed before serving any data.
  await adapter.assertQueueRoleReady();
  const mode = process.env.CHAT_SERVICE_MODE ?? "public";
  const port = Number.parseInt(process.env.PORT ?? (mode === "gateway" ? "8788" : "8080"), 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("invalid_port");
  if (mode === "gateway") {
    const runnerKey = Buffer.from(required("CHAT_RUNNER_CAPABILITY_KEY"), "base64url");
    if (runnerKey.length < 32) throw new Error("weak_runner_capability_key");
    createPrivateToolGateway({ repository: adapter.repository, runnerKey, issuer: required("CHAT_RUNNER_ISSUER"), modelId: adapter.modelId, modelProxy: adapter.modelProxy }).listen(port, "0.0.0.0");
    return;
  }
  if (mode !== "public") throw new Error("invalid_chat_service_mode");
  // Root mints HS256 tickets from the literal server-only string, never a decoded variant.
  const signingKey = new TextEncoder().encode(required("CHAT_SIGNING_KEY"));
  if (signingKey.length < 32) throw new Error("weak_chat_signing_key");
  const issuer = process.env.CHAT_TICKET_ISSUER ?? "wildhearts-web";
  const verifier = new JwtCapabilityVerifier(signingKey, issuer, adapter.isSessionActive);
  const runnerKey = Buffer.from(required("CHAT_RUNNER_CAPABILITY_KEY"), "base64url");
  const iggy = adapter.iggy;
  if (!iggy || runnerKey.length < 32) throw new Error("chat_dispatch_not_configured");
  const dispatcher = new IggyRunDispatcher(adapter.repository, iggy, runnerKey, required("CHAT_RUNNER_ISSUER"), required("CHAT_WORKER_ID"));
  let ticking = false;
  const dispatch = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await adapter.repository.interruptExpiredRuns();
      await dispatcher.dispatchOnce();
    } catch {
      // Fixed operational code only; errors can contain protected connection data.
      console.error("chat_dispatch_unavailable");
    } finally { ticking = false; }
  };
  await dispatch();
  setInterval(() => void dispatch(), 1_000).unref();
  createChatHttpServer({ repository: adapter.repository, verifier, webOrigin: required("CHAT_WEB_ORIGIN"), onCancel: (runId) => dispatcher.cancel(runId) }).listen(port, "0.0.0.0");
}

void main().catch(() => { console.error("chat_startup_failed"); process.exit(1); });
