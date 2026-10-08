import type { z } from "zod";
import { protocolEventSchema } from "./protocol.js";

export type ToolName = "get_data_coverage" | "find_records" | "read_records" | "read_stored_note" | "calculate_lab_trend" | "find_saved_summaries" | "save_summary";
export type WorkerEvent = z.infer<typeof protocolEventSchema>;
export type WorkerEventType = WorkerEvent["type"];
export type ChatMessage = Readonly<{ role: "user" | "assistant"; content: string }>;

export type ClaimedWebRun = Readonly<{
  id: string;
  attempt: number;
  leaseOwner: string;
  deadlineAt: string;
  leaseExpiresAt: string;
  executionGrant: string;
  controlGrant: string;
}>;
