import { app } from "./app";
import type { Bindings } from "./env";

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Bindings>;
