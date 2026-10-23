import { describe, expect, it } from "vitest";
import rule from "../../ops/firewall/credential-file-probes.json";

describe("credential-file firewall rule scope", () => {
  const pattern = new RegExp(rule.conditionGroup[0].conditions[0].value);

  it.each(["/.env", "/.env.local", "/.env.backup1", "/.env.production", "/.git/config", "/.aws/credentials", "/.config/gcloud/application_default_credentials.json"])("matches credential probe %s", (path) => {
    expect(pattern.test(path)).toBe(true);
  });

  it.each(["/", "/sign-in", "/app/chat", "/.well-known/openid-configuration", "/.environment", "/api/health", "/api/epic/jwks", "/api/epic/jwks/production", "/api/epic/authorize", "/api/epic/callback", "/api/auth/get-session", "/api/chat/worker/v1/claims", "/api/chat/worker/v1/control/heartbeat", "/api/extraction/worker/v1/claim", "/api/inngest"])("does not match legitimate route %s", (path) => {
    expect(pattern.test(path)).toBe(false);
  });
});
