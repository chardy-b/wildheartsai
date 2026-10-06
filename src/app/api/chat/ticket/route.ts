import { auth } from "@/lib/auth";
import { appUrl } from "@/lib/env";
import { chatConfiguration, mintChatTicket } from "@/lib/chat-auth/ticket";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store, private", "Pragma": "no-cache" };

export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(appUrl()).origin || request.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ error: "Forbidden" }, { status: 403, headers });
  }
  const identity = await auth.api.getSession({ headers: request.headers });
  if (!identity || !identity.user.emailVerified) return Response.json({ error: "Sign in required" }, { status: 401, headers });
  const config = chatConfiguration();
  if (!config) return Response.json({ error: "Chat is not available yet" }, { status: 503, headers });
  const token = await mintChatTicket({ userId: identity.user.id, sessionId: identity.session.id }, config.signingKey);
  return Response.json({ token, apiUrl: config.apiUrl, expiresIn: 90 }, { headers });
}
