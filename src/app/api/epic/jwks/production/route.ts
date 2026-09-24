import { jwksResponse } from "@/lib/epic/server";

export const dynamic = "force-dynamic";

// Epic's Production JWK Set URL. It remains a fail-closed 404 until production access is enabled.
export function GET() {
  return jwksResponse("production");
}
