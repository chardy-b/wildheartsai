import type { ConnectionSecrets } from "./connections";
import { ReconnectRequiredError } from "./errors";
import type { TokenSet } from "./tokens";

const EARLY_EXPIRY_MS = 60_000;

export function hasFreshAccessToken(connection: ConnectionSecrets, now: Date): boolean {
  return connection.accessTokenExpiresAt.getTime() - now.getTime() > EARLY_EXPIRY_MS;
}

export async function freshAccessToken(
  connection: ConnectionSecrets,
  deps: {
    now: Date;
    refresh: (connection: ConnectionSecrets) => Promise<TokenSet>;
    persist: (id: string, tokens: TokenSet) => Promise<void>;
  },
): Promise<string> {
  if (hasFreshAccessToken(connection, deps.now)) {
    return connection.accessToken;
  }
  if (!connection.refreshToken) throw new ReconnectRequiredError();
  const tokens = await deps.refresh(connection);
  await deps.persist(connection.id, tokens);
  return tokens.accessToken;
}
