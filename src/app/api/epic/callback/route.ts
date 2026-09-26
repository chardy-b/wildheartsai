import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { completeAuthorization } from "@/lib/epic/callback";
import { saveConnection } from "@/lib/epic/connections";
import { FLOW_COOKIE } from "@/lib/epic/flow";
import { clientAssertionFor, credentialsForOrganization, tokenKey } from "@/lib/epic/server";
import { exchangeCode } from "@/lib/epic/tokens";
import { env } from "@/lib/env";
import { onboardingStep } from "@/lib/onboarding";
import { completeOnboarding, getProfile } from "@/lib/profile";
import { requestSyncFor } from "@/lib/sync/server";

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.redirect(new URL("/sign-in", request.url));

  const userId = session.user.id;
  const key = tokenKey();
  const { EPIC_REDIRECT_URI } = env();
  const params = request.nextUrl.searchParams;
  const inOnboarding = onboardingStep(await getProfile(db, userId)) === "connect";
  let sourceId: string | undefined;

  const result = await completeAuthorization({
    params: { code: params.get("code"), state: params.get("state"), error: params.get("error") },
    flowCookie: request.cookies.get(FLOW_COOKIE)?.value,
    key,
    now: new Date(),
    exchange: async ({ fhirBaseUrl, tokenEndpoint, code, codeVerifier }) => {
      const credentials = credentialsForOrganization(fhirBaseUrl);
      if (!credentials) throw new Error("No Epic credentials for this health system");
      return exchangeCode({
        tokenEndpoint,
        code,
        codeVerifier,
        redirectUri: EPIC_REDIRECT_URI,
        clientId: credentials.clientId,
        clientAssertion: await clientAssertionFor(tokenEndpoint, credentials),
      });
    },
    save: async (flow, tokens) => {
      ({ sourceId } = await saveConnection(
        db,
        key,
        {
          userId,
          fhirBaseUrl: flow.fhirBaseUrl,
          organizationName: flow.organizationName,
          tokenEndpoint: flow.tokenEndpoint,
          tokens,
        },
        new Date(),
      ));
    },
  });

  // Import the records in the background. A failure to queue isn't fatal: the dashboard
  // queues a first sync for any connected source that never had one.
  if (result.ok && sourceId) {
    await requestSyncFor(userId, sourceId, "connect").catch((error: unknown) => {
      console.error("[sync] queueing failed", error instanceof Error ? error.name : "unknown");
    });
  }

  let target: string;
  if (result.ok && inOnboarding) {
    await completeOnboarding(db, userId, new Date());
    target = "/app";
  } else if (result.ok) {
    target = "/app/connections?connected=1";
  } else {
    target = `${inOnboarding ? "/app/onboarding" : "/app/connections"}?error=${result.reason}`;
  }

  const response = NextResponse.redirect(new URL(target, request.url));
  response.cookies.delete({ name: FLOW_COOKIE, path: "/api/epic" });
  return response;
}
