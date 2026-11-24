CREATE TABLE "fx_rates" (
	"base" text DEFAULT 'USD' NOT NULL,
	"quote" text NOT NULL,
	"rate" numeric(24, 10) NOT NULL,
	"as_of" date NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_quote_currencies_code_fk" FOREIGN KEY ("quote") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fx_rates_pk" ON "fx_rates" USING btree ("base","quote","as_of");--> statement-breakpoint
CREATE INDEX "fx_rates_quote_asof_idx" ON "fx_rates" USING btree ("quote","as_of" DESC NULLS LAST);