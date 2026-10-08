import { workerRequest } from "@/lib/chat-web/worker-http";
export const runtime = "nodejs";
export const maxDuration = 30;
type Context = { params: Promise<{ path: string[] }> };
async function handle(request: Request, context: Context) { return workerRequest(request, (await context.params).path); }
export const GET = handle;
export const POST = handle;
