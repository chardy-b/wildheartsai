import type { Resource } from "@/lib/fhir/types";

// Compares one query's fetched resources with what is stored for it. Pure: the
// caller computes HMACs and applies the result.

export type Fetched = {
  resource: Resource & { id: string };
  // Content HMAC, excluding `meta` so a bumped lastUpdated alone isn't a new version.
  hmac: string;
  enteredInError: boolean;
};

export type Stored = {
  id: string;
  fhirId: string;
  contentHmac: string;
  removedAt: Date | null;
  category: string | null;
};

export type Diff = {
  insert: Fetched[];
  // Changed at the source: store the new version and mark the stored one superseded.
  supersede: { stored: Stored; fetched: Fetched }[];
  unchanged: Stored[];
  // Stored as removed, but the source sent it again.
  restore: Stored[];
  remove: Stored[];
};

type WithMeta = Resource & { status?: string; verificationStatus?: { coding?: { code?: string }[] } };

// FHIR marks mistakes with status (most types) or verificationStatus (Condition, AllergyIntolerance).
export function isEnteredInError(resource: Resource): boolean {
  const r = resource as WithMeta;
  return r.status === "entered-in-error" || (r.verificationStatus?.coding ?? []).some((c) => c.code === "entered-in-error");
}

export function withoutMeta(resource: Resource): Resource {
  return { ...resource, meta: undefined } as Resource;
}

// `removalsIn`: only after a complete full pull, the query's category. Anything stored in
// it that the source no longer sent is gone. Rows another query stored are left alone.
export function diffResources(fetched: Fetched[], stored: Stored[], options: { removalsIn?: string }): Diff {
  const diff: Diff = { insert: [], supersede: [], unchanged: [], restore: [], remove: [] };
  // Paging can repeat an entry; the last copy wins.
  const incoming = new Map(fetched.map((f) => [f.resource.id, f]));
  const current = new Map(stored.map((s) => [s.fhirId, s]));

  for (const item of incoming.values()) {
    const existing = current.get(item.resource.id);
    if (!existing) diff.insert.push(item);
    else if (existing.contentHmac !== item.hmac) diff.supersede.push({ stored: existing, fetched: item });
    else if (existing.removedAt && !item.enteredInError) diff.restore.push(existing);
    else diff.unchanged.push(existing);
  }
  if (options.removalsIn !== undefined) {
    for (const existing of current.values()) {
      if (existing.category === options.removalsIn && !incoming.has(existing.fhirId) && !existing.removedAt) diff.remove.push(existing);
    }
  }
  return diff;
}
