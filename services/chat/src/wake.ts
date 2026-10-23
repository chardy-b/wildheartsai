import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { CHAT_WAKE_PATH, CHAT_WAKE_SECRET_PATTERN } from "@/lib/chat-wake-protocol.js";

/** A one-bit latch, not a job queue. Notifications during work/waits are coalesced. */
export class CoordinatorWake {
  private pending = false;
  private resume?: () => void;

  notify = (): void => {
    this.pending = true;
    this.resume?.();
  };

  async wait(timeoutMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    if (!this.pending) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          this.resume = undefined;
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        this.resume = finish;
        signal.addEventListener("abort", finish, { once: true });
      });
    }
    this.pending = false;
  }
}

/** The only ingress operation is an authenticated, empty wake hint. No job scope. */
export function createCoordinatorWakeServer(secret: string, notify: () => void) {
  if (!CHAT_WAKE_SECRET_PATTERN.test(secret)) throw new Error("invalid_chat_wake_secret");
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  const server = createServer({ maxHeaderSize: 4096, requestTimeout: 5_000, headersTimeout: 5_000 }, (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    // Do not keep a connection with an unconsumed or unexpected request body alive.
    response.setHeader("Connection", "close");
    let status = 204;
    const authorization = request.headers.authorization ?? "";
    if (request.url !== CHAT_WAKE_PATH) status = 404;
    else if (request.method !== "POST") status = 405;
    else if (!timingSafeEqual(createHash("sha256").update(authorization).digest(), expected)) status = 401;
    else if (request.headers["transfer-encoding"] || (request.headers["content-length"] && request.headers["content-length"] !== "0")) status = 400;
    else notify();
    response.writeHead(status).end();
  });
  server.maxHeadersCount = 20;
  return server;
}
