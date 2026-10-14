import { workerRequest } from "@/lib/extraction/http";
export const runtime = "nodejs";
export const maxDuration = 120;
type Context = { params: Promise<{ path: string[] }> };
async function handle(request: Request, context: Context) { return workerRequest(request, (await context.params).path); }
export const GET = handle;
export const POST = handle;
