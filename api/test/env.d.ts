import type { D1Migration } from "cloudflare:test";
import type { ChatBindings } from "../src/chat";
import type { Bindings } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends Bindings, Partial<ChatBindings> {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
