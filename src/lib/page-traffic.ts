import "server-only";
import { getSessionCookie } from "better-auth/cookies";
import { headers } from "next/headers";
import { getSession } from "./session";
import { logPageTraffic, type TrafficAuthState } from "./page-traffic-log";
import { PAGE_TRAFFIC_ROUTE_HEADER } from "./traffic-route";

/** Server render requests, not unique visitors or a patient access audit trail. */
export async function logPageRequest(): Promise<void> {
  const requestHeaders = await headers();
  const route = requestHeaders.get(PAGE_TRAFFIC_ROUTE_HEADER);
  // Proxy sets this only for GETs and replaces any caller-supplied value.
  if (!route) return;
  let authState: TrafficAuthState = "anonymous";
  if (getSessionCookie(new Headers(requestHeaders))) {
    try { authState = await getSession() ? "authenticated" : "anonymous"; }
    // Telemetry must not break public pages or classify an auth outage as anonymous traffic.
    catch { authState = "unknown"; }
  }
  logPageTraffic(authState, route, "render");
}
