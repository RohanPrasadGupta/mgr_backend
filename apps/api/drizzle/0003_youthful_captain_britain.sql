CREATE TYPE "public"."asset_class" AS ENUM('stock', 'crypto', 'fund', 'retirement', 'gold', 'fixed_deposit', 'other');--> statement-breakpoint
CREATE TYPE "public"."cost_method" AS ENUM('wavg', 'fifo', 'manual');--> statement-breakpoint
CREATE TYPE "public"."tracking" AS ENUM('units', 'value');--> statement-breakpoint
CREATE TYPE "public"."trade_type" AS ENUM('buy', 'sell', 'dividend', 'bonus', 'fee', 'contribution', 'withdrawal');--> statement-breakpoint
CREATE TABLE "asset_prices" (
	"asset_id" uuid NOT NULL,
	"as_on" date NOT NULL,
	"price_minor" numeric(28, 6) NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"class" "asset_class" NOT NULL,
	"currency" text NOT NULL,
	"tracking" "tracking" NOT NULL,
	"cost_method" "cost_method" DEFAULT 'wavg' NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"type" "trade_type" NOT NULL,
	"quantity" numeric(28, 10),
	"price_minor" numeric(28, 6),
	"amount_minor" bigint NOT NULL,
	"fee_minor" bigint DEFAULT 0 NOT NULL,
	"traded_on" date NOT NULL,
	"note" text,
	"include_in_avg" boolean DEFAULT true NOT NULL,
	"client_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "trades_amounts_nonneg" CHECK ("trades"."amount_minor" >= 0 and "trades"."fee_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "asset_prices" ADD CONSTRAINT "asset_prices_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_prices_pk" ON "asset_prices" USING btree ("asset_id","as_on");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_user_class_symbol_uq" ON "assets" USING btree ("user_id","class","symbol") WHERE "assets"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "trades_user_asset_idx" ON "trades" USING btree ("user_id","asset_id","traded_on");--> statement-breakpoint
CREATE UNIQUE INDEX "trades_user_client_uq" ON "trades" USING btree ("user_id","client_id") WHERE "trades"."client_id" is not null;