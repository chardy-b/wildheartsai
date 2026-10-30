CREATE TABLE `chat_conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`sealed_title` text,
	`archived_at` integer,
	`next_message_sequence` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_conversation_user_id_idx` ON `chat_conversation` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `chat_conversation_user_updated_idx` ON `chat_conversation` (`user_id`,"updated_at" desc);--> statement-breakpoint
CREATE TABLE `chat_coordinator` (
	`id` text PRIMARY KEY NOT NULL,
	`credential_hash` text NOT NULL,
	`disabled_at` integer,
	`claim_window_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`claim_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_coordinator_credential_idx` ON `chat_coordinator` (`credential_hash`);--> statement-breakpoint
CREATE TABLE `chat_event` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`event_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`worker_sequence` integer NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`request_digest` text,
	`sealed_payload` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `chat_conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `chat_run`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`conversation_id`,`run_id`) REFERENCES `chat_run`(`user_id`,`conversation_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_event_run_sequence_idx` ON `chat_event` (`run_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_event_run_attempt_event_idx` ON `chat_event` (`run_id`,`attempt`,`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_event_run_attempt_worker_sequence_idx` ON `chat_event` (`run_id`,`attempt`,`worker_sequence`);--> statement-breakpoint
CREATE INDEX `chat_event_user_run_idx` ON `chat_event` (`user_id`,`run_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `chat_message` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`sealed_content` text NOT NULL,
	`completed_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `chat_conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`conversation_id`) REFERENCES `chat_conversation`(`user_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_message_conversation_sequence_idx` ON `chat_message` (`conversation_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_message_owner_parent_idx` ON `chat_message` (`user_id`,`conversation_id`,`id`);--> statement-breakpoint
CREATE INDEX `chat_message_user_conversation_idx` ON `chat_message` (`user_id`,`conversation_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `chat_run` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`parent_message_id` text NOT NULL,
	`assistant_message_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`idempotency_key` text NOT NULL,
	`execution_meta` text DEFAULT '{}' NOT NULL,
	`initiating_session_id` text,
	`coordinator_id` text,
	`claim_request_id` text,
	`granted_worker_id` text,
	`deadline_at` integer,
	`execution_grant_hash` text,
	`control_grant_hash` text,
	`grants_revoked_at` integer,
	`attempt` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`cancellation_requested_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`next_event_sequence` integer DEFAULT 0 NOT NULL,
	`next_worker_sequence` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `chat_conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_message_id`) REFERENCES `chat_message`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assistant_message_id`) REFERENCES `chat_message`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`coordinator_id`) REFERENCES `chat_coordinator`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`,`conversation_id`) REFERENCES `chat_conversation`(`user_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`,`conversation_id`,`parent_message_id`) REFERENCES `chat_message`(`user_id`,`conversation_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`,`conversation_id`,`assistant_message_id`) REFERENCES `chat_message`(`user_id`,`conversation_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_run_user_idempotency_idx` ON `chat_run` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_run_coordinator_claim_idx` ON `chat_run` (`coordinator_id`,`claim_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_run_execution_grant_idx` ON `chat_run` (`execution_grant_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_run_control_grant_idx` ON `chat_run` (`control_grant_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_run_owner_parent_idx` ON `chat_run` (`user_id`,`conversation_id`,`id`);--> statement-breakpoint
CREATE INDEX `chat_run_claim_idx` ON `chat_run` (`status`,`next_attempt_at`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `chat_run_user_conversation_idx` ON `chat_run` (`user_id`,`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `chat_tool_call` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`call_order` integer NOT NULL,
	`tool_name` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`request_digest` text,
	`sealed_arguments` text NOT NULL,
	`sealed_context` text,
	`sealed_result` text,
	`result_meta` text DEFAULT '{}' NOT NULL,
	`started_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `chat_conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `chat_run`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`conversation_id`,`run_id`) REFERENCES `chat_run`(`user_id`,`conversation_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_tool_call_run_order_idx` ON `chat_tool_call` (`run_id`,`call_order`);--> statement-breakpoint
CREATE INDEX `chat_tool_call_user_run_idx` ON `chat_tool_call` (`user_id`,`run_id`,`call_order`);--> statement-breakpoint
CREATE TABLE `summary_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`summary_id` text NOT NULL,
	`kind` text NOT NULL,
	`record_id` text,
	`attachment_id` text,
	`sealed_reference` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`summary_id`) REFERENCES `user_summary`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`summary_id`) REFERENCES `user_summary`(`user_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "summary_evidence_target_kind" CHECK(("summary_evidence"."kind" = 'record' and "summary_evidence"."attachment_id" is null) or ("summary_evidence"."kind" = 'note' and "summary_evidence"."record_id" is null))
);
--> statement-breakpoint
CREATE INDEX `summary_evidence_user_summary_idx` ON `summary_evidence` (`user_id`,`summary_id`);--> statement-breakpoint
CREATE TABLE `user_summary` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`originating_run_id` text,
	`idempotency_key` text NOT NULL,
	`sealed_title` text NOT NULL,
	`sealed_content` text NOT NULL,
	`freshness` text DEFAULT 'fresh' NOT NULL,
	`deleted_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`originating_run_id`) REFERENCES `chat_run`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_summary_user_idempotency_idx` ON `user_summary` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_summary_owner_parent_idx` ON `user_summary` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `user_summary_user_updated_idx` ON `user_summary` (`user_id`,"updated_at" desc);