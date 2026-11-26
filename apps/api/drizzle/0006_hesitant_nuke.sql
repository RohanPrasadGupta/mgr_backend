ALTER TABLE "admins" ADD COLUMN "role" text DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE "admins" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Everyone who was an admin before roles existed was created by the operator (CLI / SQL): they become owners, so someone can manage admins.
UPDATE "admins" SET "role" = 'owner';
