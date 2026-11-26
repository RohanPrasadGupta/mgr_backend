ALTER TABLE "users" ADD COLUMN "currencies" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
-- Start everyone's list from what they already use: the base currency, then every account, asset and debt currency.
UPDATE "users" u SET "currencies" = ARRAY(
  SELECT c FROM (
    SELECT u."base_currency" AS c, 0 AS o
    UNION SELECT a."currency", 1 FROM "accounts" a WHERE a."user_id" = u."id" AND a."deleted_at" IS NULL
    UNION SELECT s."currency", 1 FROM "assets" s WHERE s."user_id" = u."id" AND s."deleted_at" IS NULL
    UNION SELECT d."currency", 1 FROM "debts" d WHERE d."user_id" = u."id"
  ) x GROUP BY c ORDER BY min(o), c
);
