ALTER TABLE "conversations" ADD COLUMN "last_message_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "client_id" text;--> statement-breakpoint
CREATE INDEX "conversations_activity_idx" ON "conversations" USING btree ("workspace_id","last_message_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_client_id_idx" ON "messages" USING btree ("conversation_id","client_id") WHERE "messages"."client_id" is not null;--> statement-breakpoint
-- Hand-written: fill in each chat's latest activity, at the millisecond
-- precision the app writes, so list cursors compare exactly.
UPDATE "conversations" c SET "last_message_at" = (
	SELECT date_trunc('milliseconds', max(m."created_at")) FROM "messages" m
	WHERE m."conversation_id" = c."id" AND m."role" IN ('user', 'assistant', 'system')
);--> statement-breakpoint
-- Hand-written: trigram indexes let chat search match any part of a word in
-- titles and messages without reading every message. A database that can't
-- install pg_trgm still searches, only without the index.
DO $$
BEGIN
	CREATE EXTENSION IF NOT EXISTS pg_trgm;
	CREATE INDEX IF NOT EXISTS "conversations_title_trgm_idx" ON "conversations" USING gin ("title" gin_trgm_ops);
	CREATE INDEX IF NOT EXISTS "messages_text_trgm_idx" ON "messages" USING gin (("content"->>'content') gin_trgm_ops) WHERE "role" IN ('user', 'assistant');
EXCEPTION WHEN OTHERS THEN
	RAISE NOTICE 'chat search runs without trigram indexes: %', SQLERRM;
END $$;
