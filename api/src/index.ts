import { app } from "./app";
import type { Bindings } from "./env";

export { TokenRefresher } from "./epic/token-refresher";

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Bindings>;
