import { createPrivateToolGateway } from "./private-gateway.js";
import { IggyRunDispatcher, runDispatchLoop } from "./dispatcher.js";
import { createCoordinatorRuntime, createGatewayRuntime, required } from "./runtime.js";

async function main(): Promise<void> {
  const mode = process.env.CHAT_SERVICE_MODE;
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());

  if (mode === "coordinator") {
    const runtime = createCoordinatorRuntime();
    const dispatcher = new IggyRunDispatcher(runtime.api, runtime.iggy, runtime.workerId);
    await runDispatchLoop(dispatcher, controller.signal);
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
  // Compatibility mode is intentionally not provided: no browser/public API
  // listener or database fallback exists in this service image.
  throw new Error(`invalid_chat_service_mode_${required(process.env, "CHAT_SERVICE_MODE")}`);
}

void main().catch(() => { console.error("chat_service_stopped"); process.exit(1); });
