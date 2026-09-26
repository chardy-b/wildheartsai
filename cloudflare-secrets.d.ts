// Settings the Worker reads that aren't declared in wrangler.jsonc: per-deployment URLs and
// secrets, set in the Cloudflare dashboard or with `wrangler secret put` (see README).
// OpenNext also copies every string binding into process.env, where src/lib/env.ts validates them.
interface CloudflareEnv {
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  EPIC_REDIRECT_URI?: string;
  EPIC_CLIENT_ID?: string;
  EPIC_PRIVATE_JWK?: string;
  EPIC_RETIRING_PUBLIC_JWK?: string;
  EPIC_PRODUCTION_CLIENT_ID?: string;
  EPIC_PRODUCTION_PRIVATE_JWK?: string;
  EPIC_PRODUCTION_RETIRING_PUBLIC_JWK?: string;
  SIGNUP_INVITE_CODE?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  RECORDS_ENCRYPTION_KEY?: string;
}
