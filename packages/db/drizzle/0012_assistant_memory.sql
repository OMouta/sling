CREATE TABLE "action_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"conversation_id" text,
	"message_id" text,
	"tool_call_id" text,
	"action_id" text,
	"kind" text NOT NULL,
	"node_version" integer,
	"installation_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'waiting' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"checked_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"give_up_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_results" (
	"id" text PRIMARY KEY NOT NULL,
	"check_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"passed" boolean NOT NULL,
	"state" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"ms" integer DEFAULT 0 NOT NULL,
	"detail" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"interval_seconds" integer NOT NULL,
	"deadline" timestamp with time zone,
	"runner_id" text,
	"installation_id" text,
	"state" text DEFAULT 'unknown' NOT NULL,
	"state_since" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_result" jsonb,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"notify" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"text" text NOT NULL,
	"personality_id" text,
	"source" text NOT NULL,
	"conversation_id" text,
	"message_id" text,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "memories"."text") || to_tsvector('simple', "memories"."text")) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_answers" (
	"approval_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"answer" text NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_flows" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"provider" text NOT NULL,
	"code_verifier" text NOT NULL,
	"key_version" integer NOT NULL,
	"session_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"provider" text NOT NULL,
	"refresh_token" text NOT NULL,
	"access_token" text,
	"key_version" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"action" text,
	"installation_id" text,
	"match" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"check_id" text,
	"on_event" text,
	"personality_id" text,
	"message" text,
	"mode" text,
	"approval_id" text,
	"conversation_id" text,
	"uses" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deploy_targets" ALTER COLUMN "checks" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "started_by" jsonb;--> statement-breakpoint
ALTER TABLE "deploy_targets" ADD COLUMN "check_id" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "folders" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "files" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "channels" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "action_checks" ADD CONSTRAINT "action_checks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_checks" ADD CONSTRAINT "action_checks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_checks" ADD CONSTRAINT "action_checks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_checks" ADD CONSTRAINT "action_checks_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_checks" ADD CONSTRAINT "action_checks_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_checks" ADD CONSTRAINT "action_checks_installation_id_connector_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."connector_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_results" ADD CONSTRAINT "check_results_check_id_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checks" ADD CONSTRAINT "checks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checks" ADD CONSTRAINT "checks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checks" ADD CONSTRAINT "checks_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checks" ADD CONSTRAINT "checks_installation_id_connector_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."connector_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_personality_id_personalities_id_fk" FOREIGN KEY ("personality_id") REFERENCES "public"."personalities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_answers" ADD CONSTRAINT "notification_answers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_answers" ADD CONSTRAINT "notification_answers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_flows" ADD CONSTRAINT "oauth_flows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_flows" ADD CONSTRAINT "oauth_flows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_flows" ADD CONSTRAINT "oauth_flows_installation_id_connector_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."connector_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_installation_id_connector_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."connector_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_installation_id_connector_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."connector_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_check_id_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_personality_id_personalities_id_fk" FOREIGN KEY ("personality_id") REFERENCES "public"."personalities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_checks_call_idx" ON "action_checks" USING btree ("conversation_id","tool_call_id") WHERE "action_checks"."tool_call_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "action_checks_action_idx" ON "action_checks" USING btree ("action_id") WHERE "action_checks"."action_id" is not null;--> statement-breakpoint
CREATE INDEX "action_checks_due_idx" ON "action_checks" USING btree ("next_run_at") WHERE "action_checks"."state" = 'waiting';--> statement-breakpoint
CREATE INDEX "check_results_check_idx" ON "check_results" USING btree ("check_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "checks_name_idx" ON "checks" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "checks_due_idx" ON "checks" USING btree ("next_run_at") WHERE "checks"."enabled" and "checks"."next_run_at" is not null;--> statement-breakpoint
CREATE INDEX "memories_used_idx" ON "memories" USING btree ("workspace_id","owner_id","last_used_at");--> statement-breakpoint
CREATE INDEX "memories_search_idx" ON "memories" USING gin ("search");--> statement-breakpoint
CREATE INDEX "oauth_flows_expires_idx" ON "oauth_flows" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_tokens_installation_idx" ON "oauth_tokens" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "rules_active_idx" ON "rules" USING btree ("workspace_id","kind") WHERE "rules"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "deploy_targets" ADD CONSTRAINT "deploy_targets_check_id_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deploy_targets_check_idx" ON "deploy_targets" USING btree ("check_id");--> statement-breakpoint
-- Each deploy target becomes a site check that also deploys. The check takes the target's name, URLs, version URL, and last check. The target keeps its ID and its deploy settings, so tasks and their steps still find it. Like deploys before, two failures in a row are down.
INSERT INTO "checks" ("id", "workspace_id", "owner_id", "kind", "name", "config", "enabled", "interval_seconds", "state", "state_since", "failures", "last_result", "last_run_at", "next_run_at", "notify", "created_at", "updated_at")
SELECT
  'chk_' || regexp_replace(t."id", '^[a-z]+_', ''),
  t."workspace_id",
  t."owner_id",
  'site',
  t."name",
  jsonb_build_object('kind', 'site', 'checks', t."checks", 'versionUrl', t."version_url"),
  true,
  60,
  CASE
    WHEN t."last_check" IS NULL THEN 'unknown'
    WHEN coalesce((t."last_check"->>'failures')::int, 0) >= 2 THEN 'down'
    ELSE 'up'
  END,
  CASE
    WHEN t."last_check" IS NULL THEN NULL
    WHEN (t."last_check"->>'up')::boolean OR coalesce((t."last_check"->>'failures')::int, 0) >= 2
      THEN coalesce(t."last_check"->>'since', t."last_check"->>'at')::timestamptz
    ELSE NULL
  END,
  coalesce((t."last_check"->>'failures')::int, 0),
  CASE WHEN t."last_check" IS NULL THEN NULL ELSE jsonb_build_object(
    'id', 'ckr_' || regexp_replace(t."id", '^[a-z]+_', ''),
    'checkId', 'chk_' || regexp_replace(t."id", '^[a-z]+_', ''),
    'at', t."last_check"->'at',
    'passed', coalesce((t."last_check"->>'up')::boolean, false),
    'state', CASE WHEN coalesce((t."last_check"->>'failures')::int, 0) >= 2 THEN 'down' ELSE 'up' END,
    'message', CASE
      WHEN (t."last_check"->>'up')::boolean THEN 'Every URL answered as set'
      ELSE coalesce(
        (SELECT r->>'url' || ': ' || coalesce(r->>'error', 'failed') FROM jsonb_array_elements(coalesce(t."last_check"->'results', '[]'::jsonb)) r WHERE NOT coalesce((r->>'ok')::boolean, false) LIMIT 1),
        'A check failed'
      )
    END,
    'ms', coalesce((SELECT round(max((r->>'ms')::numeric))::int FROM jsonb_array_elements(coalesce(t."last_check"->'results', '[]'::jsonb)) r), 0),
    'detail', jsonb_build_object('kind', 'site', 'checks', coalesce(t."last_check"->'results', '[]'::jsonb), 'versionSeen', NULL)
  ) END,
  (t."last_check"->>'at')::timestamptz,
  now(),
  true,
  t."created_at",
  t."updated_at"
FROM "deploy_targets" t;
--> statement-breakpoint
-- The last check of each target is the first entry in its check's history.
INSERT INTO "check_results" ("id", "check_id", "at", "passed", "state", "message", "ms", "detail")
SELECT c."last_result"->>'id', c."id", (c."last_result"->>'at')::timestamptz, (c."last_result"->>'passed')::boolean, c."last_result"->>'state', c."last_result"->>'message', (c."last_result"->>'ms')::int, c."last_result"->'detail'
FROM "checks" c
WHERE c."last_result" IS NOT NULL;
--> statement-breakpoint
UPDATE "deploy_targets" SET "check_id" = 'chk_' || regexp_replace("id", '^[a-z]+_', '');
--> statement-breakpoint
-- Every personality can remember, since memory reads and writes only Sling's own data.
UPDATE "personalities" SET "tools" = "tools" || '["memory"]'::jsonb, "revision" = "revision" + 1 WHERE NOT "tools" @> '["memory"]'::jsonb;
--> statement-breakpoint
-- The default personality also searches and reads the folders machines share.
UPDATE "personalities" SET "tools" = "tools" || '["files"]'::jsonb, "revision" = "revision" + 1 WHERE "is_default" AND NOT "tools" @> '["files"]'::jsonb;
