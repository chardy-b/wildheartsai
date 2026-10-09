import { z } from "zod";

export const chatScopeSchema = z.object({
  userId: z.string().min(1),
  conversationId: z.uuid().optional(),
  runId: z.uuid().optional(),
  runAttempt: z.number().int().positive().optional(),
  workerId: z.string().min(1).max(200).optional(),
});

export type ChatScope = z.infer<typeof chatScopeSchema>;

export const workerEventTypeSchema = z.enum([
  "lifecycle",
  "answer.delta",
  "message.completed",
  "tool.started",
  "tool.completed",
  "summary.suggested",
  "completed",
  "cancelled",
  "error",
]);

export type WorkerEventType = z.infer<typeof workerEventTypeSchema>;

// Only the broker's normalized events reach storage. The worker's raw Pi/provider event stream
// is deliberately outside this contract so it cannot become a second plaintext transcript.
export const workerEventSchema = z.object({
  eventId: z.uuid(),
  sequence: z.number().int().positive(),
  type: workerEventTypeSchema,
  data: z.record(z.string(), z.unknown()),
});

export type WorkerEvent = z.infer<typeof workerEventSchema>;

export const summaryContentSchema = z.object({
  version: z.literal(1),
  text: z.string().min(1).max(20_000),
  coverage: z.object({
    state: z.enum(["complete", "partial", "unknown"]),
    asOf: z.string().datetime().nullable(),
    sourceIds: z.array(z.uuid()).max(100),
  }),
  provenance: z.object({
    runId: z.uuid().nullable(),
    generatedAt: z.string().datetime(),
  }),
  evidence: z
    .array(
      z.object({
        id: z.uuid(),
        kind: z.enum(["record", "note"]),
      }),
    )
    .max(100),
});

export type SummaryContent = z.infer<typeof summaryContentSchema>;

export type Citation = { id: string; kind: "record" | "note" };
