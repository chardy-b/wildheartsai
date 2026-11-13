ALTER TABLE `epic_directory_entry` ADD `generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `epic_directory_entry_generation_idx` ON `epic_directory_entry` (`generation`,`fhir_base_url`);--> statement-breakpoint
ALTER TABLE `epic_directory_import` ADD `generation` integer;