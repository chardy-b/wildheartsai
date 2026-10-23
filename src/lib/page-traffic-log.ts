import "server-only";
import { trafficRoute } from "./traffic-route";

export type TrafficAuthState = "authenticated" | "anonymous" | "unknown";

export function logPageTraffic(authState: TrafficAuthState, route: string, outcome: "render" | "redirect"): void {
  console.info(JSON.stringify({
    event: "page_request", authState, route: trafficRoute(route), outcome,
  }));
}
