// Entry point for the Better Auth CLI (`npm run auth:schema`). The CLI needs a
// real instance; the app uses the lazily created one in ./auth.
import { createAuth } from "./auth";

export const auth = createAuth();
