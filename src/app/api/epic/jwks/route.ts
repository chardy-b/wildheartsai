import type { JWK } from "jose";
import { parsePrivateJwk, publicJwks } from "@/lib/epic/client-assertion";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export function GET() {
  const { EPIC_PRIVATE_JWK, EPIC_RETIRING_PUBLIC_JWK } = env();
  const retiring = EPIC_RETIRING_PUBLIC_JWK ? (JSON.parse(EPIC_RETIRING_PUBLIC_JWK) as JWK) : undefined;
  return Response.json(publicJwks(parsePrivateJwk(EPIC_PRIVATE_JWK), retiring), {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}
