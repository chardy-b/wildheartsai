ALTER TABLE "wildcard_file" ADD COLUMN "upload_chunk_count" integer;--> statement-breakpoint
ALTER TABLE "wildcard_file" ADD COLUMN "upload_parts" jsonb;