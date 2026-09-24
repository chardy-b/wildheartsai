import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { buildAuthorizeUrl } from "@/lib/epic/authorize";
import { findOrganization, loadDirectory } from "@/lib/epic/directory";
import { encodeFlow, FLOW_COOKIE, FLOW_TTL_SECONDS } from "@/lib/epic/flow";
import { createPkcePair, createState } from "@/lib/epic/pkce";
import { tokenKey } from "@/lib/epic/server";
import { discoverSmartConfiguration } from "@/lib/epic/smart";
import { env } from "@/lib/env";

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.redirect(new URL("/sign-in", request.url));

  const { EPIC_ENVIRONMENT, EPIC_CLIENT_ID, EPIC_REDIRECT_URI } = env();
  const iss = request.nextUrl.searchParams.get("iss") ?? "";
  const organization = findOrganization(await loadDirectory(EPIC_ENVIRONMENT), iss);
  if (!organization) return NextResponse.json({ error: "unknown_organization" }, { status: 400 });

  let smart;
  try {
    smart = await discoverSmartConfiguration(organization.fhirBaseUrl);
  } catch (error) {
    console.error("[epic] discovery failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.redirect(new URL("/app/connections?error=unavailable", request.url));
  }

  const { verifier, challenge } = createPkcePair();
  const state = createState();
  const response = NextResponse.redirect(
    buildAuthorizeUrl({
      authorizationEndpoint: smart.authorizationEndpoint,
      clientId: EPIC_CLIENT_ID,
      redirectUri: EPIC_REDIRECT_URI,
      state,
      codeChallenge: challenge,
      aud: organization.fhirBaseUrl,
    }),
  );
  response.cookies.set(
    FLOW_COOKIE,
    encodeFlow(
      {
        state,
        verifier,
        fhirBaseUrl: organization.fhirBaseUrl,
        organizationName: organization.name,
        tokenEndpoint: smart.tokenEndpoint,
        createdAt: Date.now(),
      },
      tokenKey(),
    ),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/epic",
      maxAge: FLOW_TTL_SECONDS,
    },
  );
  return response;
}
