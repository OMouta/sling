CREATE TABLE "extension_catalogs" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"fetched_at" timestamp with time zone,
	"etag" text,
	"error" text,
	"document" jsonb,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_catalogs_url_unique" UNIQUE("url")
);
--> statement-breakpoint
CREATE TABLE "extension_packages" (
	"extension_id" text NOT NULL,
	"version" text NOT NULL,
	"digest" text NOT NULL,
	"size" integer NOT NULL,
	"archive" "bytea" NOT NULL,
	"manifest" jsonb NOT NULL,
	"description" jsonb,
	"contents" jsonb NOT NULL,
	"signature" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_packages_extension_id_version_pk" PRIMARY KEY("extension_id","version")
);
--> statement-breakpoint
CREATE TABLE "extension_publishers" (
	"key_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"public_key" text NOT NULL,
	"trusted_by" text,
	"trusted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extensions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"version" text NOT NULL,
	"source" text NOT NULL,
	"catalog_id" text,
	"publisher_key_id" text,
	"publisher_name" text,
	"signed" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'stopped' NOT NULL,
	"status_detail" text,
	"granted" jsonb NOT NULL,
	"revoked_reason" text,
	"installed_by" text,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "extension_catalogs" ADD CONSTRAINT "extension_catalogs_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_packages" ADD CONSTRAINT "extension_packages_extension_id_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_publishers" ADD CONSTRAINT "extension_publishers_trusted_by_users_id_fk" FOREIGN KEY ("trusted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extensions" ADD CONSTRAINT "extensions_installed_by_users_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;