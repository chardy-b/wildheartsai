import { createPrivateToolGateway } from "./private-gateway.js";
import { IggyRunDispatcher, runDispatchLoop } from "./dispatcher.js";
import { createCoordinatorRuntime, createGatewayRuntime, required } from "./runtime.js";
import { once } from "node:events";
import { CoordinatorWake, createCoordinatorWakeServer } from "./wake.js";

async function main(): Promise<void> {
  const mode = process.env.CHAT_SERVICE_MODE;
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());

  if (mode === "coordinator") {
    const runtime = createCoordinatorRuntime();
    const dispatcher = new IggyRunDispatcher(runtime.api, runtime.iggy, runtime.workerId);
    const wake = runtime.wake ? new CoordinatorWake() : undefined;
    const listener = runtime.wake && wake ? createCoordinatorWakeServer(runtime.wake.secret, wake.notify) : undefined;
    if (listener) {
      listener.listen(runtime.wake!.port, "0.0.0.0");
      await once(listener, "listening");
    }
    console.info(JSON.stringify({ event: "chat_coordinator_started", mode: wake ? "notifications" : "polling" }));
    try { await runDispatchLoop(dispatcher, controller.signal, { wake }); }
    finally { if (listener) await new Promise<void>((resolve) => listener.close(() => resolve())); }
    return;
  }
  if (mode === "gateway") {
    const runtime = createGatewayRuntime();
    const port = Number.parseInt(process.env.PORT ?? "8080", 10);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("invalid_port");
    const gateway = createPrivateToolGateway(runtime);
    gateway.listen(port, "0.0.0.0");
    await new Promise<void>((resolve) => {
      controller.signal.addEventListener("abort", () => gateway.close(() => resolve()), { once: true });
    });
    return;
  }
  // No browser/patient-data API or database fallback exists in this service image.
  throw new Error(`invalid_chat_service_mode_${required(process.env, "CHAT_SERVICE_MODE")}`);
}

void main().catch(() => { console.error("chat_service_stopped"); process.exit(1); });
