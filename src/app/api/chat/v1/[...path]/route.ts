import { browserRequest } from "@/lib/chat-web/browser-http";
export const runtime = "nodejs";
export const maxDuration = 30;
type Context = { params: Promise<{ path: string[] }> };
async function handle(request: Request, context: Context) { return browserRequest(request, (await context.params).path); }
export const GET = handle;
export const POST = handle;
export const DELETE = handle;
