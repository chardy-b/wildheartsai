ALTER TABLE "wildcard_file" ADD COLUMN "content_hmac" text;--> statement-breakpoint
CREATE INDEX "wildcard_file_user_content_idx" ON "wildcard_file" USING btree ("user_id","content_hmac");