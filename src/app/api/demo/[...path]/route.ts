import { demoRequest } from "@/lib/demo/http";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) { return demoRequest(request, (await context.params).path); }
export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) { return demoRequest(request, (await context.params).path); }
