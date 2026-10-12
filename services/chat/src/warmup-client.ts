import type { ModelWarmupLease } from "./dispatcher.js";

const gatewayUrl = new URL("http://wildhearts-chat-gateway:8080/v1/warmup");

/** Calls only the fixed private gateway route; no caller-controlled URL or prompt. */
export class GatewayWarmupClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async run(lease: ModelWarmupLease): Promise<boolean> {
    const remainingMs = Date.parse(lease.expiresAt) - Date.now() - 15_000;
    if (!Number.isFinite(remainingMs) || remainingMs < 1_000) return false;
    try {
      const response = await this.fetcher(gatewayUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${lease.grant}`, "content-type": "application/json" },
        body: "{}",
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(135_000, remainingMs)),
      });
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); return false; }
      const reader = response.body?.getReader();
      if (!reader) return false;
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 1_024) { await reader.cancel().catch(() => undefined); return false; }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))));
      return !!body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 1 && (body as { status?: unknown }).status === "ready";
    } catch {
      return false;
    }
  }
}
