CREATE TABLE "connector_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"connector_id" text NOT NULL,
	"name" text NOT NULL,
	"credential_id" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"status_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_state" (
	"installation_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_state_installation_id_key_pk" PRIMARY KEY("installation_id","key")
);
--> statement-breakpoint
CREATE TABLE "node_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"node_id" text NOT NULL,
	"node_type" text NOT NULL,
	"iteration" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"exec_port" text,
	"inputs" jsonb,
	"outputs" jsonb,
	"error" jsonb,
	"idempotency_key" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "run_waits" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"node_run_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"key" text,
	"event_type" text,
	"resume_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_kv" (
	"workflow_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_kv_workflow_id_key_pk" PRIMARY KEY("workflow_id","key")
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"version_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger_node_id" text NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_payload" jsonb NOT NULL,
	"concurrency_key" text,
	"cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"error" jsonb,
	"parent_run_id" text,
	"parent_node_run_id" text,
	"dedupe_key" text,
	"node_run_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"version_id" text NOT NULL,
	"node_id" text NOT NULL,
	"event" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"installation_id" text,
	"webhook_token_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_triggers_webhook_token_hash_unique" UNIQUE("webhook_token_hash")
);
--> statement-breakpoint
CREATE TABLE "workflow_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"number" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"active_version_id" text,
	"draft" jsonb NOT NULL,
	"draft_dirty" boolean DEFAULT true NOT NULL,
	"template_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "action_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "kind" text DEFAULT 'task_action' NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "decided_via" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "workflow_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "external_key" text;--> statement-breakpoint
ALTER TABLE "connector_installations" ADD CONSTRAINT "connector_installations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_installations" ADD CONSTRAINT "connector_installations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_installations" ADD CONSTRAINT "connector_installations_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_state" ADD CONSTRAINT "connector_state_installation_id_connector_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."connector_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_runs" ADD CONSTRAINT "node_runs_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_runs" ADD CONSTRAINT "node_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_waits" ADD CONSTRAINT "run_waits_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_waits" ADD CONSTRAINT "run_waits_node_run_id_node_runs_id_fk" FOREIGN KEY ("node_run_id") REFERENCES "public"."node_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_waits" ADD CONSTRAINT "run_waits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_kv" ADD CONSTRAINT "workflow_kv_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_kv" ADD CONSTRAINT "workflow_kv_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_version_id_workflow_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_version_id_workflow_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_installations_workspace_idx" ON "connector_installations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "node_runs_run_idx" ON "node_runs" USING btree ("run_id","started_at");--> statement-breakpoint
CREATE INDEX "run_waits_key_idx" ON "run_waits" USING btree ("kind","key");--> statement-breakpoint
CREATE INDEX "workflow_runs_workflow_idx" ON "workflow_runs" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_status_idx" ON "workflow_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workflow_runs_key_idx" ON "workflow_runs" USING btree ("concurrency_key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_dedupe_idx" ON "workflow_runs" USING btree ("workflow_id","dedupe_key") WHERE "workflow_runs"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "workflow_triggers_event_idx" ON "workflow_triggers" USING btree ("workspace_id","event");--> statement-breakpoint
CREATE INDEX "workflow_triggers_workflow_idx" ON "workflow_triggers" USING btree ("workflow_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_number_idx" ON "workflow_versions" USING btree ("workflow_id","number");--> statement-breakpoint
CREATE INDEX "workflows_workspace_idx" ON "workflows" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_external_key_idx" ON "conversations" USING btree ("workspace_id","external_key") WHERE "conversations"."external_key" is not null;