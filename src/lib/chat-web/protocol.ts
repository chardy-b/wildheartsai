import { z } from "zod";

// Runtime-neutral wire contracts shared by the web authority and VPS transport.
export const CHAT_DEADLINE_MS = 5 * 60_000;
export const CHAT_LEASE_MS = 30_000;
export const CHAT_CLAIMS_PER_MINUTE = 6;
export const CHAT_MAX_REQUEST_BYTES = 64 * 1024;
export const CHAT_MAX_CONTEXT_BYTES = 128 * 1024;
export const CHAT_MAX_TOOL_OUTPUT_BYTES = 192 * 1024;
export const CHAT_MAX_EVENT_BYTES = 128 * 1024;
export const CHAT_MAX_EVENTS = 256;
export const CHAT_MAX_USER_QUEUED = 3;
export const claimInputSchema = z.object({ requestId: z.uuid(), workerId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/) }).strict();
export const toolInputSchema = z.object({
  toolCallId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  tool: z.enum(["get_data_coverage", "find_records", "read_records", "read_stored_note", "calculate_lab_trend", "find_saved_summaries", "save_summary"]),
  input: z.record(z.string(), z.unknown()),
}).strict();
const eventData = {
  lifecycle: z.object({ status: z.enum(["started", "starting", "running"]).optional() }).strict(),
  "answer.delta": z.object({ text: z.string().min(1).max(12_000) }).strict(),
  "message.completed": z.object({ content: z.string().max(12_000) }).strict(),
  "tool.started": z.object({ toolCallId: toolInputSchema.shape.toolCallId, tool: toolInputSchema.shape.tool }).strict(),
  "tool.completed": z.object({ toolCallId: toolInputSchema.shape.toolCallId, status: z.enum(["completed", "rejected", "failed"]) }).strict(),
  "summary.suggested": z.object({ summaryId: z.uuid().optional() }).strict(),
  completed: z.object({ answer: z.string().min(1).max(12_000) }).strict(),
  cancelled: z.object({}).strict(),
  error: z.object({ code: z.enum(["worker_failed", "worker_timeout", "inference_unavailable"]).optional() }).strict(),
};
const eventTypes = Object.keys(eventData) as [keyof typeof eventData, ...(keyof typeof eventData)[]];
export const protocolEventSchema = z.object({ eventId: z.uuid(), sequence: z.number().int().positive(), type: z.enum(eventTypes), data: z.record(z.string(), z.unknown()) }).strict().superRefine((event, ctx) => {
  if (!eventData[event.type].safeParse(event.data).success) ctx.addIssue({ code: "custom", message: "Invalid event data" });
});
export const eventsInputSchema = z.object({ events: z.array(protocolEventSchema).min(1).max(32) }).strict();
export const finalizeInputSchema = z.object({ requestId: z.uuid(), status: z.enum(["failed", "cancelled", "interrupted"]), errorCode: z.enum(["runner_start_failed", "runner_failed", "worker_timeout", "coordinator_stopped"]).optional() }).strict();
export type ClaimInput = z.infer<typeof claimInputSchema>;
export type ToolInput = z.infer<typeof toolInputSchema>;
export type EventsInput = z.infer<typeof eventsInputSchema>;
export type FinalizeInput = z.infer<typeof finalizeInputSchema>;
export type ClaimReply = { id: string; attempt: number; leaseOwner: string; deadlineAt: string; leaseExpiresAt: string; executionGrant: string; controlGrant: string };
export type OperationAck = { status: "accepted" | "duplicate" };
export type HeartbeatReply = { active: boolean; cancelled: boolean; deadlineAt: string };
export type ToolReply = { status: "completed"; output: Record<string, unknown> };
export type ContextReply = { messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>; modelId: string };
export class ChatAuthorityError extends Error {
  constructor(readonly code: "unauthorized" | "run_not_active" | "invalid_request" | "quota_exceeded" | "claim_conflict", readonly status: number = 409) { super(code); this.name = "ChatAuthorityError"; }
}
