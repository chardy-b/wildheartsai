/** Transport-neutral contracts. Content is plaintext only while a trusted process executes a run. */
export type ChatScope = Readonly<{
  userId: string;
  conversationId: string;
  runId?: string;
  credentialId: string;
  expiresAt: Date;
  /** Present only on a capability issued for one currently-held worker lease. */
  runAttempt?: number;
  workerId?: string;
}>;

/** A browser ticket is deliberately not bound to a conversation or run. Routes bind those after ownership checks. */
export type PublicCapability = Readonly<{
  userId: string;
  sessionId: string;
  credentialId: string;
  expiresAt: Date;
  audience: "wildhearts-chat";
}>;

export type ChatEventKind =
  | "run.started"
  | "answer.delta"
  | "tool.started"
  | "tool.completed"
  | "answer.completed"
  | "run.completed"
  | "run.cancelled"
  | "run.failed";

export type ChatEvent = Readonly<{
  sequence: number;
  kind: ChatEventKind;
  payload: Record<string, unknown>;
  createdAt: Date;
}>;

export type ClaimedRun = Readonly<{
  id: string;
  scope: ChatScope;
  /** Decrypted, bounded canonical context ending at this run's parent user message; later tabs never enter it. */
  messages: ReadonlyArray<Readonly<{ role: "user" | "assistant"; content: string }>>;
  attempt: number;
  leaseOwner: string;
}>;

export type ToolName = "get_data_coverage" | "find_records" | "read_records" | "read_stored_note" | "calculate_lab_trend" | "find_saved_summaries" | "save_summary";

export type ToolResult = Readonly<{
  status: "completed" | "rejected" | "failed";
  output: Record<string, unknown>;
  evidence?: ReadonlyArray<Record<string, unknown>>;
  truncated?: boolean;
}>;

export interface ChatRepository {
  listConversations(scope: Pick<ChatScope, "userId" | "credentialId" | "expiresAt">): Promise<ReadonlyArray<ConversationListItem>>;
  createConversation(scope: Pick<ChatScope, "userId" | "credentialId" | "expiresAt">): Promise<ConversationListItem>;
  getConversation(scope: ChatScope): Promise<ConversationDetail | null>;
  deleteConversation(scope: ChatScope): Promise<boolean>;
  listSummaries(scope: Pick<ChatScope, "userId" | "credentialId" | "expiresAt">): Promise<ReadonlyArray<SummaryListItem>>;
  deleteSummary(scope: Pick<ChatScope, "userId" | "credentialId" | "expiresAt">, summaryId: string): Promise<boolean>;
  createRun(input: { scope: ChatScope; idempotencyKey: string; message: string }): Promise<{ runId: string; created: boolean }>;
  getRun(scope: ChatScope, runId: string): Promise<{ id: string; status: string } | null>;
  findRunForUser(scope: Pick<ChatScope, "userId" | "credentialId" | "expiresAt">, runId: string): Promise<{ id: string; conversationId: string; status: string } | null>;
  claimNextRun(workerId: string, leaseMs: number): Promise<ClaimedRun | null>;
  interruptExpiredRuns(): Promise<number>;
  loadRunContext(scope: ChatScope): Promise<ClaimedRun["messages"]>;
  renewLease(scope: ChatScope, workerId: string, leaseMs: number): Promise<boolean>;
  isWorkerLeaseCurrent(scope: ChatScope): Promise<boolean>;
  isCancellationRequested(scope: ChatScope): Promise<boolean>;
  requestCancellation(scope: ChatScope): Promise<boolean>;
  appendWorkerEvent(scope: ChatScope, event: { eventId: string; sequence: number; type: WorkerEventType; data: Record<string, unknown> }): Promise<"accepted" | "duplicate" | "out_of_order">;
  finalizeWorkerEvent(scope: ChatScope, event: { eventId: string; sequence: number; type: WorkerEventType; data: Record<string, unknown> }, result: { status: "completed" | "failed" | "cancelled"; answer?: string }): Promise<void>;
  listEvents(scope: ChatScope, afterSequence: number): Promise<ReadonlyArray<ChatEvent>>;
  finalizeServiceEvent(scope: ChatScope, result: { status: "failed" | "cancelled"; errorCode?: string }): Promise<void>;
  invokeTool(scope: ChatScope, request: { toolCallId: string; tool: ToolName; input: Record<string, unknown> }): Promise<ToolResult>;
}

export type WorkerEventType = "lifecycle" | "answer.delta" | "message.completed" | "tool.started" | "tool.completed" | "summary.suggested" | "completed" | "cancelled" | "error";

export type ConversationListItem = Readonly<{ id: string; title: string; createdAt: Date; updatedAt: Date }>;
export type ConversationDetail = Readonly<{
  conversation: ConversationListItem;
  messages: ReadonlyArray<Readonly<{ id: string; role: "user" | "assistant"; content: string; createdAt: Date }>>;
  runs: ReadonlyArray<Readonly<{ id: string; status: string; createdAt: Date; completedAt?: Date }>>;
}>;
export type SummaryListItem = Readonly<{ id: string; title: string; content: { text: string }; createdAt: Date; updatedAt: Date }>;

export interface CapabilityVerifier {
  verify(token: string): Promise<PublicCapability | null>;
}
