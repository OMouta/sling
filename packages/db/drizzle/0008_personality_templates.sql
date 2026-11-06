ALTER TABLE "personalities" ADD COLUMN "template_key" text;--> statement-breakpoint
-- The personalities a workspace was first given came from these templates.
UPDATE "personalities" p SET "template_key" = lower(p."name")
WHERE p."name" IN ('Sling', 'Finance')
  AND p."created_at" = (SELECT min(q."created_at") FROM "personalities" q WHERE q."workspace_id" = p."workspace_id");
