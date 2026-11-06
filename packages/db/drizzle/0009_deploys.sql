CREATE TABLE "deploy_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"remote_key" text NOT NULL,
	"method" text NOT NULL,
	"merge_method" text DEFAULT 'squash' NOT NULL,
	"runner_id" text,
	"hook_credential_id" text,
	"hook_host" text,
	"hook_method" text,
	"hook_has_header" boolean DEFAULT false NOT NULL,
	"checks" jsonb NOT NULL,
	"version_url" text,
	"settle_seconds" integer DEFAULT 0 NOT NULL,
	"timeout_seconds" integer DEFAULT 600 NOT NULL,
	"last_check" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_delivered_at" timestamp with time zone,
	"last_error" text,
	"failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "target_id" text;--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "runner_id" text;--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "commit_sha" text;--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "output" text;--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "detail" jsonb;--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "deploy_command" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "deploys" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "notifications" jsonb;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "deploy_targets" ADD CONSTRAINT "deploy_targets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploy_targets" ADD CONSTRAINT "deploy_targets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploy_targets" ADD CONSTRAINT "deploy_targets_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploy_targets" ADD CONSTRAINT "deploy_targets_hook_credential_id_credentials_id_fk" FOREIGN KEY ("hook_credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deploy_targets_name_idx" ON "deploy_targets" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "deploy_targets_remote_idx" ON "deploy_targets" USING btree ("workspace_id","remote_key");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_target_id_deploy_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."deploy_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "personalities" SET "tools" = '["commands","coding","apps","deploys"]'::jsonb, "revision" = "revision" + 1 WHERE "is_default" AND "tools" @> '["commands","coding"]'::jsonb;
