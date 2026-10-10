CREATE TABLE "shortcut_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"provider_application_id" text,
	"slug" text NOT NULL,
	"workspace_name" text NOT NULL,
	"bot_member_id" text NOT NULL,
	"api_token" text NOT NULL,
	"connected_by_user_id" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shortcut_connections_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
ALTER TABLE "shortcut_connections" ADD CONSTRAINT "shortcut_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortcut_connections" ADD CONSTRAINT "shortcut_connections_connected_by_user_id_user_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shortcut_connections_id_organization_unique" ON "shortcut_connections" USING btree ("id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shortcut_connections_organization_slug_unique" ON "shortcut_connections" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "shortcut_connections_organization_external_unique" ON "shortcut_connections" USING btree ("organization_id","workspace_id");