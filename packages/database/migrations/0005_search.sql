ALTER TABLE "comments" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(body, ''))) STORED;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "search_text" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(search_text, '')), 'B')) STORED;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(description, '')), 'B')) STORED;--> statement-breakpoint
CREATE INDEX "comments_search_idx" ON "comments" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "documents_search_idx" ON "documents" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "issues_search_idx" ON "issues" USING gin ("search_vector");