CREATE TABLE "personalities" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"instructions" text NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"color" text NOT NULL,
	"shape" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "personality_id" text;--> statement-breakpoint
ALTER TABLE "personalities" ADD CONSTRAINT "personalities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personalities" ADD CONSTRAINT "personalities_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personalities_workspace_idx" ON "personalities" USING btree ("workspace_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "personalities_default_idx" ON "personalities" USING btree ("workspace_id") WHERE "personalities"."is_default" and "personalities"."archived_at" is null;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_personality_id_personalities_id_fk" FOREIGN KEY ("personality_id") REFERENCES "public"."personalities"("id") ON DELETE set null ON UPDATE no action;