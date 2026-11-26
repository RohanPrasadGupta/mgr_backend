import { z } from "zod";
import { currencyCode, isoDate, uuid } from "./common";

export const assetClasses = ["stock", "crypto", "fund", "retirement", "gold", "fixed_deposit", "other"] as const;
export const tradeTypes = ["buy", "sell", "dividend", "bonus", "fee", "contribution", "withdrawal"] as const;
/** Default tracking by class: instruments with unit prices are tracked in units, pooled money (SIP, SSF, FD…) by value. */
export const defaultTracking = (c: (typeof assetClasses)[number]): "units" | "value" => (c === "stock" || c === "crypto" || c === "gold" ? "units" : "value");

export const createAssetSchema = z.object({
  symbol: z.string().trim().min(1).max(30).transform((s) => s.toUpperCase()),
  name: z.string().trim().min(1).max(100),
  class: z.enum(assetClasses),
  currency: currencyCode,
  tracking: z.enum(["units", "value"]).optional(),
  costMethod: z.enum(["wavg", "fifo", "manual"]).default("wavg"),
});
export const updateAssetSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    costMethod: z.enum(["wavg", "fifo", "manual"]),
    archived: z.boolean(),
    /** How entries are recorded (units × price, or amount only). Can only change while the asset has no entries. */
    tracking: z.enum(["units", "value"]),
    /** Show/total this asset in another currency at a rate you choose (1 asset currency = rate × convertCurrency); null removes it. */
    convertCurrency: z.string().length(3).transform((s) => s.toUpperCase()).nullable(),
    convertRate: z.number().positive().max(1e9).nullable(),
    /** Relabels the asset and its trades/prices (amounts are not converted; recorded in the wrong currency → fix the label). */
    currency: z.string().length(3).transform((s) => s.toUpperCase()),
  })
  .partial();

const money0 = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const createTradeSchema = z
  .object({
    assetId: uuid,
    type: z.enum(tradeTypes),
    quantity: z.number().positive().max(1e12).optional(),
    priceMinor: z.number().positive().max(1e15).optional(), // per unit, minor units (may be fractional)
    amountMinor: money0.optional(), // gross total; derived from quantity × price for buy/sell when omitted
    feeMinor: money0.default(0),
    tradedOn: isoDate.optional(),
    note: z.string().max(500).optional(),
    includeInAvg: z.boolean().default(true),
    clientId: uuid.optional(),
  })
  .superRefine((t, ctx) => {
    const need = (ok: boolean, path: string, message: string) => ok || ctx.addIssue({ code: "custom", path: [path], message });
    if (t.type === "buy" || t.type === "sell") {
      need(t.quantity !== undefined, "quantity", "quantity is required");
      need(t.priceMinor !== undefined || t.amountMinor !== undefined, "priceMinor", "priceMinor or amountMinor is required");
    } else if (t.type === "bonus") {
      need(t.quantity !== undefined, "quantity", "quantity is required");
    } else {
      need(t.amountMinor !== undefined && t.amountMinor > 0, "amountMinor", "amountMinor must be positive");
    }
  });
export const updateTradeSchema = z
  .object({
    /** Change the kind of entry (e.g. a buy recorded as a sell); the API checks the fields the new kind needs. */
    type: z.enum(tradeTypes),
    /** null clears it (an amount-only entry that no longer notes its units) */
    quantity: z.number().positive().max(1e12).nullable(),
    priceMinor: z.number().positive().max(1e15),
    amountMinor: money0,
    feeMinor: money0,
    tradedOn: isoDate,
    note: z.string().max(500).nullable(),
    includeInAvg: z.boolean(),
  })
  .partial();
export const listTradesSchema = z.object({
  assetId: uuid.optional(),
  type: z.enum(tradeTypes).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export const setPriceSchema = z.object({ asOn: isoDate.optional(), priceMinor: z.number().positive().max(1e15) });
/** How many month-ends of portfolio history to return (the current month ends today). */
export const portfolioHistorySchema = z.object({ months: z.coerce.number().int().min(1).max(120).default(12) });
export type PortfolioHistoryInput = z.infer<typeof portfolioHistorySchema>;
export const sipCalcSchema = z.object({ monthly: z.number().positive().max(1e12), annualRatePct: z.number().min(0).max(100), years: z.number().positive().max(80) });

/** Rows exported from the v1 stock_analysis_backend Mongo collections (mongoexport JSON is accepted). */
export const v1InvestmentSources = ["stock-transactions", "stock-capital", "coin-capital", "sip-capital", "ssf-capital"] as const;
export const importInvestmentsSchema = z.object({
  source: z.enum(v1InvestmentSources),
  rows: z.array(z.unknown()).min(1).max(10_000),
  dryRun: z.boolean().default(false),
});

export type CreateAssetInput = z.infer<typeof createAssetSchema>;
export type UpdateAssetInput = z.infer<typeof updateAssetSchema>;
export type CreateTradeInput = z.infer<typeof createTradeSchema>;
export type UpdateTradeInput = z.infer<typeof updateTradeSchema>;
export type ListTradesInput = z.infer<typeof listTradesSchema>;
export type SetPriceInput = z.infer<typeof setPriceSchema>;
export type ImportInvestmentsInput = z.infer<typeof importInvestmentsSchema>;
