CREATE TABLE `audit_event` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_id` text,
	`action` text NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_event_user_idx` ON `audit_event` (`user_id`,"created_at" desc);--> statement-breakpoint
CREATE TABLE `background_job_run` (
	`id` text PRIMARY KEY NOT NULL,
	`job` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`due` integer DEFAULT 0 NOT NULL,
	`queued` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `background_job_run_job_started_idx` ON `background_job_run` (`job`,"started_at" desc);--> statement-breakpoint
CREATE TABLE `profile` (
	`user_id` text PRIMARY KEY NOT NULL,
	`preferred_name` text,
	`consent_version` text,
	`consented_at` integer,
	`onboarded_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `rate_limit` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limit_key_unique` ON `rate_limit` (`key`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`parent_session_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE INDEX `session_parent_idx` ON `session` (`parent_session_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `epic_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_id` text NOT NULL,
	`fhir_base_url` text NOT NULL,
	`organization_name` text NOT NULL,
	`token_endpoint` text NOT NULL,
	`sealed_patient_id` text NOT NULL,
	`sealed_access_token` text NOT NULL,
	`sealed_refresh_token` text,
	`access_token_expires_at` integer NOT NULL,
	`scope` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `health_source`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `epic_connection_source_id_unique` ON `epic_connection` (`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `epic_connection_user_org_idx` ON `epic_connection` (`user_id`,`fhir_base_url`);--> statement-breakpoint
CREATE TABLE `metriport_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_id` text NOT NULL,
	`persona` text,
	`sealed_patient_id` text NOT NULL,
	`facility_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `health_source`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metriport_connection_source_id_unique` ON `metriport_connection` (`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `metriport_connection_user_persona_idx` ON `metriport_connection` (`user_id`,`persona`);--> statement-breakpoint
CREATE TABLE `epic_directory_entry` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`fhir_base_url` text NOT NULL,
	`part_of` text,
	`location` text,
	`search_text` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `epic_directory_entry_url_idx` ON `epic_directory_entry` (`fhir_base_url`);--> statement-breakpoint
CREATE TABLE `epic_directory_import` (
	`id` text PRIMARY KEY NOT NULL,
	`imported_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`content_hash` text NOT NULL,
	`changed` integer NOT NULL,
	`organizations` integer NOT NULL,
	`facilities` integer NOT NULL,
	`addresses` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `extraction_job` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`durable` integer DEFAULT false NOT NULL,
	`claim_id` text,
	`grant_hash` text,
	`deadline_at` integer,
	`error_code` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `extraction_run`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `extraction_job_claim_id_unique` ON `extraction_job` (`claim_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `extraction_job_grant_hash_unique` ON `extraction_job` (`grant_hash`);--> statement-breakpoint
CREATE INDEX `extraction_job_queue_idx` ON `extraction_job` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `extraction_reference` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`file_id` text NOT NULL,
	`sealed_labels` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `wildcard_file`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `extraction_reference_file_idx` ON `extraction_reference` (`user_id`,`file_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `extraction_run` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`file_id` text NOT NULL,
	`method` text NOT NULL,
	`sealed_config` text NOT NULL,
	`sealed_result` text,
	`result_digest` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `wildcard_file`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `extraction_run_file_idx` ON `extraction_run` (`user_id`,`file_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `wildcard_file` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`sealed_metadata` text NOT NULL,
	`content_fingerprint` text,
	`object_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`upload_chunk_count` integer,
	`upload_parts` text,
	`size_bytes` integer NOT NULL,
	`uploaded_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wildcard_file_object_key_unique` ON `wildcard_file` (`object_key`);--> statement-breakpoint
CREATE INDEX `wildcard_file_user_uploaded_idx` ON `wildcard_file` (`user_id`,`uploaded_at`);--> statement-breakpoint
CREATE INDEX `wildcard_file_user_fingerprint_idx` ON `wildcard_file` (`user_id`,`content_fingerprint`);--> statement-breakpoint
CREATE INDEX `wildcard_file_user_size_idx` ON `wildcard_file` (`user_id`,`size_bytes`);--> statement-breakpoint
CREATE TABLE `fhir_attachment` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`sealed_url` text NOT NULL,
	`url_hmac` text NOT NULL,
	`content_type` text,
	`size` integer,
	`sealed_text` text,
	`sealed_bytes` text,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `health_source`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resource_id`) REFERENCES `fhir_resource`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fhir_attachment_source_url_idx` ON `fhir_attachment` (`source_id`,`url_hmac`);--> statement-breakpoint
CREATE TABLE `fhir_resource` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`fhir_id` text NOT NULL,
	`category` text,
	`effective_at` integer,
	`date_precision` text,
	`source_version_id` text,
	`source_updated_at` integer,
	`content_hmac` text NOT NULL,
	`sealed_resource` text NOT NULL,
	`sealed_summary` text NOT NULL,
	`normalizer_version` integer NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`superseded_at` integer,
	`superseded_by` text,
	`removed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `health_source`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`superseded_by`) REFERENCES `fhir_resource`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fhir_resource_current_idx` ON `fhir_resource` (`source_id`,`resource_type`,`fhir_id`) WHERE "fhir_resource"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX `fhir_resource_timeline_idx` ON `fhir_resource` (`user_id`,"effective_at" desc,`id`) WHERE "fhir_resource"."superseded_at" is null and "fhir_resource"."removed_at" is null;--> statement-breakpoint
CREATE INDEX `fhir_resource_category_idx` ON `fhir_resource` (`user_id`,`category`,"effective_at" desc,`id`) WHERE "fhir_resource"."superseded_at" is null and "fhir_resource"."removed_at" is null;--> statement-breakpoint
CREATE TABLE `health_source` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`vendor` text NOT NULL,
	`fhir_base_url` text NOT NULL,
	`organization_name` text NOT NULL,
	`status` text NOT NULL,
	`last_synced_at` integer,
	`last_sync_status` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `health_source_user_url_idx` ON `health_source` (`user_id`,`fhir_base_url`);--> statement-breakpoint
CREATE TABLE `sync_cursor` (
	`source_id` text NOT NULL,
	`query_key` text NOT NULL,
	`last_success_at` integer,
	`last_full_at` integer,
	`supports_last_updated` integer,
	PRIMARY KEY(`source_id`, `query_key`),
	FOREIGN KEY (`source_id`) REFERENCES `health_source`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sync_run` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_id` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`stats` text DEFAULT '{}' NOT NULL,
	`queued_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `health_source`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_run_active_idx` ON `sync_run` (`source_id`) WHERE "sync_run"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX `sync_run_source_idx` ON `sync_run` (`source_id`,"queued_at" desc);--> statement-breakpoint
CREATE TABLE `user_data_key` (
	`user_id` text PRIMARY KEY NOT NULL,
	`sealed_dek` text NOT NULL,
	`kek_version` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
