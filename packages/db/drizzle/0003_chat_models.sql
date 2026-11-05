ALTER TABLE "conversations" ADD COLUMN "settings" jsonb;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "found_repos" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "remote_repos" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "agent_model" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "agent_effort" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "agent_fast" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "chat_defaults" jsonb;