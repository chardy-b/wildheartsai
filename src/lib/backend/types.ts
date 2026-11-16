import type { Organization } from "@/lib/epic/directory";
import type { RecordItem } from "@/lib/fhir/normalize";
import type { Profile } from "@/lib/profile";
import type { RecordProblem } from "@/lib/records";
import type { NoteResult } from "@/lib/records-notes";
import type { SourceSummary } from "@/lib/sources";
import type { TimelineCursor, TimelineFilters } from "@/lib/timeline-filters";
import type { WildcardFile } from "@/lib/wildcards";
import type { loadDocumentFhir } from "@/lib/extraction/fhir-store";

// What pages, layouts and server actions need from the backend. Two implementations while
// production still runs on Vercel (docs/superpowers/plans/2026-10-30-cloudflare-migration.md):
// - direct.ts: Postgres and the app's own modules, as on Vercel today;
// - api.ts: the Hono API Worker over a service binding, on Cloudflare.
// The API derives the person from the session cookie; `userId` is for the direct backend.

// The fields of a session that pages use. Both backends return at least these.
export type AppSession = {
  user: { id: string; email: string; name: string; emailVerified: boolean; image?: string | null };
  session: { id: string; userId: string; expiresAt: Date };
};

export type TimelineView = { sources: SourceSummary[]; items: RecordItem[]; related: RecordItem[]; next: TimelineCursor | null; problems: RecordProblem[] };

export type ConnectSettings = { environment: "sandbox" | "production"; expandedScopes: boolean; metriportEnabled: boolean };
export type ConnectChoices = { results: Organization[]; sample: Organization | null };

export type DocumentFhirView = NonNullable<Awaited<ReturnType<typeof loadDocumentFhir>>>;

export type SignUpSettings = { signupsEnabled: boolean; inviteRequired: boolean };

export type Backend = {
  signUpSettings(): Promise<SignUpSettings>;
  // The signed-in person (with demo workspace selection on Vercel), without renewing the session.
  session(requestHeaders: Headers): Promise<AppSession | null>;
  // The real login, never a demo workspace.
  realSession(requestHeaders: Headers): Promise<AppSession | null>;

  profile(userId: string): Promise<Profile | undefined>;
  savePreferredName(userId: string, preferredName: string): Promise<void>;
  recordAcknowledgement(userId: string): Promise<void>;
  completeOnboarding(userId: string): Promise<void>;

  sources(userId: string): Promise<SourceSummary[]>;
  timeline(userId: string, filters: TimelineFilters, cursor: TimelineCursor | null): Promise<TimelineView>;
  note(userId: string, sourceId: string, attachmentUrl: string): Promise<NoteResult>;
  // The FHIR Bundle download for these query-string filters.
  exportRecords(userId: string, search: URLSearchParams): Promise<Response>;

  connectChoices(query: string): Promise<{ settings: ConnectSettings; choices: ConnectChoices | null }>;
  refresh(userId: string, sourceId: string): Promise<string>;
  refreshAll(userId: string): Promise<string>;
  disconnect(userId: string, connectionId: string): Promise<void>;
  deleteSource(userId: string, sourceId: string): Promise<void>;
  // Where to send the person afterwards.
  connectMetriport(userId: string, personaId: string): Promise<string>;

  // Documents: whether file storage is set up, a page of the listing (the requested page, kept
  // within the pages there are) with usage, and one file.
  documentsAvailable(): boolean;
  documents(userId: string, requestedPage: number): Promise<{ files: WildcardFile[]; usage: { count: number; bytes: number }; page: number }>;
  document(userId: string, id: string): Promise<WildcardFile | null>;
  // Every ready document, for the extraction workbench and progress pages.
  readyDocuments(userId: string): Promise<WildcardFile[]>;
  // A document as FHIR resources; `error` when its extraction can't be shown, null when missing.
  documentFhir(userId: string, id: string, runId?: string): Promise<{ data: DocumentFhirView } | { error: string } | null>;
};
