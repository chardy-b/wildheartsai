import { DurableObject } from "cloudflare:workers";
import { freshAccessToken, hasFreshAccessToken } from "@/lib/epic/access";
import { EpicError, ReconnectRequiredError, type EpicStage, type ReconnectReason } from "@/lib/epic/errors";
import { refreshAccessToken } from "@/lib/epic/tokens";
import { getConnection, updateTokens, type ConnectionSecrets } from "../data/connections";
import { forUser } from "../data/scope";
import { database } from "../db";
import { secrets, type Bindings } from "../env";
import { clientAssertionFor, credentialsForOrganization, tokenKey } from "./credentials";

// Epic rotates refresh tokens: spending one twice forces the person to reconnect. On Postgres a
// row lock held across the call to Epic kept refreshes of one connection apart (audit pattern N,
// docs/superpowers/specs/2026-10-30-d1-transaction-audit.md). Here one Durable Object per
// connection does it: one refresh at a time, shared by everyone who asks meanwhile, and each
// refresh re-reads the connection first so it never starts from a token already replaced.

// Errors don't keep their class across Durable Object RPC, so outcomes travel as data.
export type RefreshOutcome =
  | { ok: true; accessToken: string }
  | { ok: false; error: "reconnect"; reason: ReconnectReason; status?: number }
  | { ok: false; error: "epic"; stage: EpicStage; status?: number; code?: string };

function outcomeOf(error: unknown): RefreshOutcome {
  if (error instanceof ReconnectRequiredError) return { ok: false, error: "reconnect", reason: error.reason, status: error.status };
  if (error instanceof EpicError) return { ok: false, error: "epic", stage: error.stage, status: error.status, code: error.code };
  console.error("[epic] refresh failed", error instanceof Error ? error.name : "unknown");
  return { ok: false, error: "epic", stage: "refresh", code: "unexpected_error" };
}

export class TokenRefresher extends DurableObject<Bindings> {
  private inflight?: Promise<RefreshOutcome>;

  async accessToken(userId: string, connectionId: string): Promise<RefreshOutcome> {
    // Joining another caller's refresh is safe only for the connection's owner.
    const scope = forUser(database(this.env.DB), userId);
    const key = tokenKey(secrets(this.env));
    if (!(await getConnection(scope, key, connectionId))) return { ok: false, error: "epic", stage: "refresh", code: "connection_unavailable" };
    this.inflight ??= this.refresh(userId, connectionId).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async refresh(userId: string, connectionId: string): Promise<RefreshOutcome> {
    const config = secrets(this.env);
    const scope = forUser(database(this.env.DB), userId);
    const key = tokenKey(config);
    try {
      const current = await getConnection(scope, key, connectionId);
      if (!current) return { ok: false, error: "epic", stage: "refresh", code: "connection_unavailable" };
      const accessToken = await freshAccessToken(current, {
        now: new Date(),
        refresh: async (c) => {
          const credentials = credentialsForOrganization(config, c.fhirBaseUrl);
          if (!c.refreshToken) throw new ReconnectRequiredError("missing_refresh_token");
          if (!credentials) throw new EpicError("refresh", undefined, "missing_credentials");
          const clientAssertion = await clientAssertionFor(c.tokenEndpoint, credentials).catch(() => {
            throw new EpicError("refresh", undefined, "invalid_client_configuration");
          });
          return refreshAccessToken({ tokenEndpoint: c.tokenEndpoint, refreshToken: c.refreshToken, clientId: credentials.clientId, clientAssertion });
        },
        persist: async (id, tokens) => {
          await updateTokens(scope, key, id, tokens, new Date());
        },
      });
      return { ok: true, accessToken };
    } catch (error) {
      return outcomeOf(error);
    }
  }
}

// A usable access token for the connection: the stored one while it's fresh, otherwise a refresh
// through the connection's TokenRefresher. Throws the same errors as the Next app's accessTokenFor.
export async function accessTokenFor(env: Bindings, userId: string, connection: ConnectionSecrets): Promise<string> {
  if (hasFreshAccessToken(connection, new Date())) return connection.accessToken;
  const refresher = env.TOKEN_REFRESHER.get(env.TOKEN_REFRESHER.idFromName(connection.id));
  const outcome = await refresher.accessToken(userId, connection.id);
  if (outcome.ok) return outcome.accessToken;
  if (outcome.error === "reconnect") throw new ReconnectRequiredError(outcome.reason, outcome.status);
  throw new EpicError(outcome.stage, outcome.status, outcome.code);
}
