import { auth } from "@/lib/auth";

// auth is created lazily on the first request, so the build never needs its secrets.
export const GET = (request: Request) => auth.handler(request);
export const POST = (request: Request) => auth.handler(request);
