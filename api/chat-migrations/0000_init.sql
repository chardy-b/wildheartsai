CREATE TABLE `chat_conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`records_user_id` text NOT NULL,
	`title` text DEFAULT 'New conversation' NOT NULL,
	`expires_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_conversation_owner_created_idx` ON `chat_conversation` (`owner_id`,"created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `chat_conversation_expires_idx` ON `chat_conversation` (`expires_at`);--> statement-breakpoint
CREATE TABLE `chat_run` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `chat_conversation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_run_owner_idx` ON `chat_run` (`owner_id`,`id`);--> statement-breakpoint
CREATE TABLE `summary_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`summary_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_id` text NOT NULL,
	`version` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`summary_id`) REFERENCES `user_summary`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `summary_evidence_owner_summary_idx` ON `summary_evidence` (`owner_id`,`summary_id`);--> statement-breakpoint
CREATE TABLE `user_summary` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`originating_run_id` text,
	`idempotency_key` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`deleted_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_summary_owner_idempotency_idx` ON `user_summary` (`owner_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `user_summary_owner_created_idx` ON `user_summary` (`owner_id`,"created_at" desc,"id" desc);