import { z } from "zod";
import { researchToolSchemas } from "../../../src/lib/chat/tools.js";

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
export const CHAT_MAX_RESEARCH_OUTPUT_BYTES = 32 * 1024;
export const RESEARCH_GATEWAY_HEADER = "X-Chat-Research-Gateway-Token";
export const researchSnapshotSchema = z.string().regex(/^[a-f0-9]{64}$/);
const researchCommandSchema = z.discriminatedUnion("tool", [
  z.object({ toolCallId: toolInputSchema.shape.toolCallId, tool: z.literal("search_research"), input: researchToolSchemas.search_research }).strict(),
  z.object({ toolCallId: toolInputSchema.shape.toolCallId, tool: z.literal("read_research"), input: researchToolSchemas.read_research }).strict(),
]);
export const agentToolInputSchema = z.union([toolInputSchema, researchCommandSchema]);
const researchReadyBeginInputSchema = z.discriminatedUnion("tool", [
  researchCommandSchema.options[0].extend({ proposedSnapshotId: researchSnapshotSchema }).strict(),
  researchCommandSchema.options[1].extend({ proposedSnapshotId: researchSnapshotSchema }).strict(),
]).superRefine((value, ctx) => {
  if (value.tool === "read_research" && value.input.snapshotId !== value.proposedSnapshotId) ctx.addIssue({ code: "custom", message: "Snapshot mismatch" });
});
// An unavailable initial capture still produces a durable bounded tool failure, without a fake snapshot.
const researchUnavailableBeginInputSchema = researchCommandSchema.options[0].extend({ proposedSnapshotId: z.null(), failureCode: z.literal("research_unavailable") }).strict();
export const researchBeginInputSchema = z.union([researchReadyBeginInputSchema, researchUnavailableBeginInputSchema]);
const relativeMarkdownPath = z.string().min(1).max(500).refine(value => !value.startsWith("/") && !value.includes("\\") && !value.includes(":") && !/[\x00-\x1f\x7f]/.test(value) && value.endsWith(".md") && value.split("/").every(part => part.length > 0 && part !== "." && part !== ".."), "Invalid source path");
export const researchPassageSchema = z.object({
  sourceId: researchSnapshotSchema, title: z.string().min(1).max(300), path: relativeMarkdownPath,
  startLine: z.number().int().positive().max(10_000_000), endLine: z.number().int().positive().max(10_000_000),
  excerpt: z.string().max(12_000), offset: z.number().int().min(0).max(10_000_000),
  nextOffset: z.number().int().min(0).max(10_000_000).nullable(), totalChars: z.number().int().min(0).max(10_000_000), truncated: z.boolean(),
}).strict().superRefine((value, ctx) => {
  const excerptChars = Array.from(value.excerpt).length;
  const end = value.offset + excerptChars;
  if (value.endLine < value.startLine || end > value.totalChars || value.nextOffset !== (end < value.totalChars ? end : null) || (value.nextOffset !== null && excerptChars === 0) || value.truncated !== (value.offset > 0 || end < value.totalChars)) ctx.addIssue({ code: "custom", message: "Invalid passage bounds" });
});
export const researchSearchOutputSchema = z.object({ snapshotId: researchSnapshotSchema, hits: z.array(researchPassageSchema).max(5), truncated: z.boolean() }).strict();
export const researchReadOutputSchema = researchPassageSchema.safeExtend({ snapshotId: researchSnapshotSchema });
export const researchOutputSchema = z.union([researchSearchOutputSchema, researchReadOutputSchema]);
export const researchErrorCodeSchema = z.enum(["research_unavailable", "snapshot_unavailable", "source_not_found", "research_failed", "result_too_large"]);
export const researchResultInputSchema = z.discriminatedUnion("status", [
  z.object({ operationId: z.uuid(), status: z.literal("completed"), output: researchOutputSchema }).strict(),
  z.object({ operationId: z.uuid(), status: z.literal("failed"), errorCode: researchErrorCodeSchema }).strict(),
]);
export type AgentToolInput = z.infer<typeof agentToolInputSchema>;
export type ResearchSearchOutput = z.infer<typeof researchSearchOutputSchema>;
export type ResearchReadOutput = z.infer<typeof researchReadOutputSchema>;
export type ResearchBeginInput = z.infer<typeof researchBeginInputSchema>;
export type ResearchResultInput = z.infer<typeof researchResultInputSchema>;
export type ResearchOutput = z.infer<typeof researchOutputSchema>;
export type ResearchErrorCode = z.infer<typeof researchErrorCodeSchema>;
export type ResearchBeginReply = { status: "execute"; operationId: string; snapshotId: string; deadlineAt: string } | { status: "completed"; operationId: string; output: ResearchOutput } | { status: "failed"; operationId: string; errorCode: ResearchErrorCode };
const eventData = {
  lifecycle: z.object({ status: z.enum(["started", "starting", "running"]).optional() }).strict(),
  "answer.delta": z.object({ text: z.string().min(1).max(12_000) }).strict(),
  "message.completed": z.object({ content: z.string().max(12_000) }).strict(),
  "tool.started": z.object({ toolCallId: toolInputSchema.shape.toolCallId, tool: z.enum(["get_data_coverage", "find_records", "read_records", "read_stored_note", "calculate_lab_trend", "find_saved_summaries", "save_summary", "search_research", "read_research"]) }).strict(),
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
