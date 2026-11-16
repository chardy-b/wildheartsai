import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { buildAuthorizeUrl, requestedScopes } from "@/lib/epic/authorize";
import { completeAuthorization } from "@/lib/epic/callback";
import { encodeFlow, FLOW_COOKIE, FLOW_TTL_SECONDS } from "@/lib/epic/flow";
import { createPkcePair, createState } from "@/lib/epic/pkce";
import { discoverSmartConfiguration } from "@/lib/epic/smart";
import { exchangeCode } from "@/lib/epic/tokens";
import { onboardingStep } from "@/lib/onboarding";
import { saveConnection } from "../data/connections";
import { findConnectable } from "../data/directory";
import { completeOnboarding, getProfile } from "../data/profile";
import { requestSync } from "../data/sync-runs";
import { database } from "../db";
import { enabledEpicEnvironment, secrets } from "../env";
import { clientAssertionFor, credentialsForOrganization, jwksResponse, tokenKey } from "../epic/credentials";
import { notInDemo, requireUser, type AppEnv } from "../session";
import { sendTo } from "../sync-queue";

// Connecting a health system with SMART on FHIR (src/app/api/epic/* in the Next app): the same
// paths, the same flow cookie and the same redirects, so Epic's registered URLs don't change.
export const epicRoutes = new Hono<AppEnv>();

// Epic's JWK Set URLs: the public keys for the sandbox and production clients.
epicRoutes.get("/epic/jwks", (c) => jwksResponse(secrets(c.env), "sandbox"));
// Stays a fail-closed 404 until production access is enabled.
epicRoutes.get("/epic/jwks/production", (c) => jwksResponse(secrets(c.env), "production"));

epicRoutes.get("/epic/authorize", requireUser("redirect"), notInDemo((c) => c.json({ error: "Use the fictional clinic feeds in demo mode. Return to your account to connect a health system." }, 403)), async (c) => {
  const config = secrets(c.env);
  const environment = enabledEpicEnvironment(config);
  const iss = c.req.query("iss") ?? "";
  // `org` names which of the address's listed systems the person picked; only a listed name is used.
  const org = c.req.query("org");
  let organization;
  try {
    organization = await findConnectable(database(c.env.DB), environment, iss, org);
  } catch (error) {
    console.error("[epic] directory lookup failed", error instanceof Error ? error.name : "unknown");
    return c.redirect(new URL("/app/connections?error=unavailable", c.req.url).toString());
  }
  const credentials = organization && credentialsForOrganization(config, organization.fhirBaseUrl);
  if (!organization || !credentials) return c.json({ error: "unknown_organization" }, 400);

  let smart;
  try {
    smart = await discoverSmartConfiguration(organization.fhirBaseUrl);
  } catch (error) {
    console.error("[epic] discovery failed", error instanceof Error ? error.name : "unknown");
    return c.redirect(new URL("/app/connections?error=unavailable", c.req.url).toString());
  }

  const { verifier, challenge } = createPkcePair();
  const state = createState();
  setCookie(
    c,
    FLOW_COOKIE,
    encodeFlow(
      { state, verifier, fhirBaseUrl: organization.fhirBaseUrl, organizationName: organization.name, tokenEndpoint: smart.tokenEndpoint, createdAt: Date.now() },
      tokenKey(config),
    ),
    { httpOnly: true, secure: config.BETTER_AUTH_URL.startsWith("https://"), sameSite: "Lax", path: "/api/epic", maxAge: FLOW_TTL_SECONDS },
  );
  return c.redirect(
    buildAuthorizeUrl({
      authorizationEndpoint: smart.authorizationEndpoint,
      clientId: credentials.clientId,
      redirectUri: config.EPIC_REDIRECT_URI,
      state,
      codeChallenge: challenge,
      aud: organization.fhirBaseUrl,
      scopes: requestedScopes(config.EPIC_EXPANDED_SCOPES),
    }),
  );
});

epicRoutes.get("/epic/callback", requireUser("redirect"), notInDemo((c) => c.json({ error: "Live health-system connections are unavailable in demo mode." }, 403)), async (c) => {
  const config = secrets(c.env);
  const scope = c.get("scope");
  const key = tokenKey(config);
  const inOnboarding = onboardingStep(await getProfile(scope)) === "connect";
  let sourceId: string | undefined;

  const result = await completeAuthorization({
    params: { code: c.req.query("code") ?? null, state: c.req.query("state") ?? null, error: c.req.query("error") ?? null },
    flowCookie: getCookie(c, FLOW_COOKIE),
    key,
    now: new Date(),
    exchange: async ({ fhirBaseUrl, tokenEndpoint, code, codeVerifier }) => {
      const credentials = credentialsForOrganization(config, fhirBaseUrl);
      if (!credentials) throw new Error("No Epic credentials for this health system");
      return exchangeCode({
        tokenEndpoint,
        code,
        codeVerifier,
        redirectUri: config.EPIC_REDIRECT_URI,
        clientId: credentials.clientId,
        clientAssertion: await clientAssertionFor(tokenEndpoint, credentials),
      });
    },
    save: async (flow, tokens) => {
      ({ sourceId } = await saveConnection(scope, key, { fhirBaseUrl: flow.fhirBaseUrl, organizationName: flow.organizationName, tokenEndpoint: flow.tokenEndpoint, tokens }, new Date()));
    },
  });

  // Import the records in the background. A failure to queue isn't fatal: the dashboard queues a
  // first sync for any connected source that never had one.
  if (result.ok && sourceId) {
    await requestSync(scope, { sourceId, trigger: "connect" }, sendTo(c.env), new Date()).catch((error: unknown) => {
      console.error("[sync] queueing failed", error instanceof Error ? error.name : "unknown");
    });
  }

  let target: string;
  if (result.ok && inOnboarding) {
    await completeOnboarding(scope, new Date());
    target = "/app";
  } else if (result.ok) {
    target = "/app/connections?connected=1";
  } else {
    target = `${inOnboarding ? "/app/onboarding" : "/app/connections"}?error=${result.reason}`;
  }
  deleteCookie(c, FLOW_COOKIE, { path: "/api/epic" });
  return c.redirect(new URL(target, c.req.url).toString());
});
