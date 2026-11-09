CREATE TABLE "webhook_secrets" (
	"workflow_id" text NOT NULL,
	"node_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"previous_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "webhook_secrets_workflow_id_node_id_pk" PRIMARY KEY("workflow_id","node_id")
);
--> statement-breakpoint
ALTER TABLE "webhook_secrets" ADD CONSTRAINT "webhook_secrets_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_secrets" ADD CONSTRAINT "webhook_secrets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_secrets" ADD CONSTRAINT "webhook_secrets_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_runs_active_idx" ON "workflow_runs" USING btree ("workflow_id","trigger_node_id") WHERE "workflow_runs"."status" in ('queued', 'running', 'waiting');