import type { NextRequest } from "next/server";
import { backend } from "@/lib/backend";
import { requireOnboarded } from "@/lib/onboarding-guard";

// Downloads the records the timeline filters select (same query string as /app), as a FHIR Bundle.
export async function GET(request: NextRequest) {
  const { session } = await requireOnboarded();
  return (await backend()).exportRecords(session.user.id, request.nextUrl.searchParams);
}
