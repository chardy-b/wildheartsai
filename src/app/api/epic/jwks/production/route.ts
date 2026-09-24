import { jwksResponse } from "@/lib/epic/server";

export const dynamic = "force-dynamic";

// Epic's Production JWK Set URL.
export function GET() {
  return jwksResponse("production");
}
