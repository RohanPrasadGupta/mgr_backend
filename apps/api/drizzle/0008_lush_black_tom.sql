ALTER TABLE "assets" ADD COLUMN "convert_currency" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "convert_rate" double precision;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_convert_currency_currencies_code_fk" FOREIGN KEY ("convert_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_convert_pair" CHECK (("convert_currency" IS NULL) = ("convert_rate" IS NULL) AND ("convert_rate" IS NULL OR "convert_rate" > 0));
