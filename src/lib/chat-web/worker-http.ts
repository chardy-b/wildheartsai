import "server-only";
import { webChatRuntime } from "./runtime";
import { bearer, body, guarded, json, ChatRequestError } from "./http";
import { logChatRunFailure } from "./logging";
import { claimInputSchema, modelWarmupClaimInputSchema, modelWarmupCompleteInputSchema, toolInputSchema, eventsInputSchema, finalizeInputSchema, researchBeginInputSchema, researchResultInputSchema, RESEARCH_GATEWAY_HEADER, chatFailureCodeSchema } from "./protocol";

/** Explicit bearer-only operations; a cookie never authorizes a worker operation. */
export function workerRequest(request: Request, path: string[]): Promise<Response> {
  return guarded(async (requestId) => {
    const token = bearer(request);
    const route = path.join("/");
    const allowed = request.method === "GET" ? ["execution/context", "execution/cancellation"] : request.method === "POST" ? ["claims", "warmup/claim", "warmup/complete", "execution/warmup/verify", "execution/tools", "execution/events", "execution/research/begin", "execution/research/result", "control/heartbeat", "control/finalize"] : [];
    if (!allowed.includes(route)) throw new ChatRequestError(404, "not_found");
    const { authority } = await webChatRuntime();
    switch (route) {
      case "claims": return json({ run: await authority.claim(token, claimInputSchema.parse(await body(request))) });
      case "warmup/claim": return json({ warmup: await authority.claimModelWarmup(token, modelWarmupClaimInputSchema.parse(await body(request))) });
      case "warmup/complete": return json(await authority.completeModelWarmup(token, modelWarmupCompleteInputSchema.parse(await body(request))), 202);
      case "execution/warmup/verify": return json(await authority.verifyModelWarmup(token));
      case "execution/context": return json(await authority.context(token));
      case "execution/cancellation": return json(await authority.cancellation(token));
      case "execution/tools": return json(await authority.tool(token, toolInputSchema.parse(await body(request))));
      case "execution/research/begin": return json(await authority.researchBegin(token, request.headers.get(RESEARCH_GATEWAY_HEADER) ?? "", researchBeginInputSchema.parse(await body(request))));
      case "execution/research/result": return json(await authority.researchResult(token, request.headers.get(RESEARCH_GATEWAY_HEADER) ?? "", researchResultInputSchema.parse(await body(request))), 202);
      case "execution/events": {
        const input = eventsInputSchema.parse(await body(request));
        const result = await authority.events(token, input);
        if (result.status === "accepted") for (const event of input.events) {
          if (event.type === "error") {
            const code = event.data.code;
            const parsed = chatFailureCodeSchema.safeParse(code);
            logChatRunFailure(parsed.success ? parsed.data : "unspecified", requestId);
          }
        }
        return json(result, 202);
      }
      case "control/heartbeat": return json(await authority.heartbeat(token));
      case "control/finalize": {
        const input = finalizeInputSchema.parse(await body(request));
        const result = await authority.finalize(token, input);
        if (result.status === "accepted" && input.status !== "cancelled") logChatRunFailure(input.errorCode ?? "unspecified", requestId);
        return json(result, 202);
      }
      default: throw new ChatRequestError(404, "not_found");
    }
  }, { surface: "worker", method: request.method, path });
}
