import "server-only";
import { cache } from "react";
import { db } from "@/lib/db";
import { getConnectionSecrets } from "@/lib/epic/connections";
import { accessTokenFor, tokenKey } from "@/lib/epic/server";
import { fhirSearch } from "@/lib/fhir/client";
import { gatherRecords, type RecordsResult } from "@/lib/records";

// Fetched live for every request and never stored. cache() de-duplicates within one request.
export const loadRecordsFor = cache(async (userId: string): Promise<RecordsResult> => {
  const connections = await getConnectionSecrets(db, tokenKey(), userId);
  return gatherRecords(connections, {
    accessToken: accessTokenFor,
    search: (input) => fhirSearch(input),
  });
});
