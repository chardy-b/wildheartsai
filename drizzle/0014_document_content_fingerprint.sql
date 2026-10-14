ALTER TABLE "wildcard_file" ADD COLUMN "content_fingerprint" text;--> statement-breakpoint
CREATE INDEX "wildcard_file_user_fingerprint_idx" ON "wildcard_file" USING btree ("user_id","content_fingerprint");--> statement-breakpoint
CREATE INDEX "wildcard_file_user_size_idx" ON "wildcard_file" USING btree ("user_id","size_bytes");