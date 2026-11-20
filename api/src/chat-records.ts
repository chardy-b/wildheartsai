import { WorkerEntrypoint } from "cloudflare:workers";
import * as records from "./data/chat-records";
import type { Bindings } from "./env";

// The chat Worker's only way into the main database: a service binding to this entrypoint
// (`RECORDS` in api/wrangler.chat.jsonc). Its methods are exactly the functions in
// src/data/chat-records.ts; test/chat-records.test.ts fails on any method not listed there, so
// a new one needs a deliberate review.
export class ChatRecords extends WorkerEntrypoint<Bindings> {
  identify(cookie: string) { return records.identify(this.env, cookie); }
  sessionFence(fence: records.Fence) { return records.sessionFence(this.env, fence); }
  dataCoverage(userId: string) { return records.dataCoverage(this.env, userId); }
  findRecords(userId: string, input: unknown) { return records.findRecords(this.env, userId, input); }
  readRecords(userId: string, input: unknown) { return records.readRecords(this.env, userId, input); }
  readStoredNote(userId: string, input: unknown) { return records.readStoredNote(this.env, userId, input); }
  labTrend(userId: string, input: unknown) { return records.labTrend(this.env, userId, input); }
  evidence(userId: string, targets: { kind: "record" | "note"; targetId: string }[]) { return records.evidence(this.env, userId, targets); }
  recordSources(userId: string, receipts: Parameters<typeof records.recordSources>[2]) { return records.recordSources(this.env, userId, receipts); }
}
