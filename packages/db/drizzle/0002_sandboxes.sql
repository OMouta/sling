CREATE TABLE "sandbox_repos" (
	"workspace_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"remote_key" text NOT NULL,
	"clone_url" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"network" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_repos_workspace_id_remote_key_pk" PRIMARY KEY("workspace_id","remote_key")
);
--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"provider_installation_id" text NOT NULL,
	"task_id" text,
	"runner_id" text,
	"state" text DEFAULT 'requested' NOT NULL,
	"external_id" text,
	"image" text DEFAULT '' NOT NULL,
	"harness" text DEFAULT 'codex' NOT NULL,
	"remote_key" text NOT NULL,
	"boot_code_hash" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provisioning_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"destroyed_at" timestamp with time zone,
	"failure" text,
	"minutes" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "runner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "repo_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "remote_key" text;--> statement-breakpoint
ALTER TABLE "runner_enrollments" ADD COLUMN "sandbox_id" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "labels" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "ephemeral" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "sandbox_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "environment" text DEFAULT 'machine' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "sandbox_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "routing" jsonb;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "default_harness" text DEFAULT 'codex' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "sandbox_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_repos" ADD CONSTRAINT "sandbox_repos_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_repos" ADD CONSTRAINT "sandbox_repos_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandboxes_workspace_idx" ON "sandboxes" USING btree ("workspace_id","requested_at");--> statement-breakpoint
CREATE INDEX "sandboxes_state_idx" ON "sandboxes" USING btree ("state");--> statement-breakpoint
ALTER TABLE "runner_enrollments" ADD CONSTRAINT "runner_enrollments_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repos_remote_key_idx" ON "repos" USING btree ("workspace_id","remote_key");--> statement-breakpoint
-- Remote keys for repos reported before they existed. Mirrors remoteKey() in @sling/core;
-- Runners also send them again on every connect.
UPDATE "repos" AS r SET "remote_key" = k."key"
FROM (
  SELECT "id", CASE WHEN "host" <> '' AND "path" LIKE '%/%' THEN lower("host" || '/' || "path") END AS "key"
  FROM (
    SELECT "id",
      CASE
        WHEN "u" ~ '^[A-Za-z0-9_.-]+@[^:/]+:.+$' THEN substring("u" from '^[A-Za-z0-9_.-]+@([^:/]+):')
        WHEN "u" ~* '^(https?|ssh|git)://' THEN substring("u" from '^[A-Za-z]+://(?:[^/@]*@)?([^/:?#]+)')
      END AS "host",
      regexp_replace(regexp_replace(
        CASE
          WHEN "u" ~ '^[A-Za-z0-9_.-]+@[^:/]+:.+$' THEN regexp_replace("u", '^[A-Za-z0-9_.-]+@[^:/]+:', '')
          WHEN "u" ~* '^(https?|ssh|git)://' THEN regexp_replace("u", '^[A-Za-z]+://[^/]*', '')
          ELSE ''
        END, '^/+', ''), '\.git$', '', 'i') AS "path"
    FROM (
      SELECT "id", regexp_replace(regexp_replace(btrim("remote_url"), '\.git$', '', 'i'), '/+$', '') AS "u"
      FROM "repos" WHERE "remote_key" IS NULL AND "remote_url" <> ''
    ) AS s
  ) AS p
) AS k
WHERE r."id" = k."id" AND k."key" IS NOT NULL;
