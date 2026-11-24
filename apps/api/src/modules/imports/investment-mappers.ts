import { toLocalDate, toMinor, type EngineTrade, type v1InvestmentSources } from "@moneymgr/shared";

export type V1Source = (typeof v1InvestmentSources)[number];
export interface MappedRow {
  asset: { symbol: string; name: string; class: "stock" | "crypto" | "fund" | "retirement"; tracking: "units" | "value"; currency: string };
  prefersManualCost: boolean;
  trade: { type: EngineTrade["type"]; quantity: number | null; priceMinor: number | null; amountMinor: number; feeMinor: number; tradedOn: string; note: string | null; includeInAvg: boolean };
  key: string;
}

type Doc = Record<string, unknown>;
const unwrap = (v: unknown): unknown => (v && typeof v === "object" && "$date" in (v as Doc) ? (v as Doc)["$date"] : v && typeof v === "object" && "$oid" in (v as Doc) ? (v as Doc)["$oid"] : v);
const str = (v: unknown) => (typeof unwrap(v) === "string" ? (unwrap(v) as string).trim() : "");
const numOrNull = (v: unknown) => { const u = unwrap(v); const n = typeof u === "number" ? u : typeof u === "string" && u.trim() !== "" ? Number(u) : NaN; return Number.isFinite(n) ? n : null; };

function dateOf(v: unknown, tz: string): string {
  const u = unwrap(v);
  const d = typeof u === "string" || typeof u === "number" ? new Date(u) : u instanceof Date ? u : null;
  if (!d || Number.isNaN(d.getTime())) throw new Error("invalid date");
  return toLocalDate(d, tz);
}
const side = (v: unknown, fallback = "BUY") => {
  const s = (str(v) || fallback).toUpperCase();
  if (s !== "BUY" && s !== "SELL") throw new Error(`type must be BUY or SELL, got "${str(v)}"`);
  return s;
};
const positive = (n: number | null, name: string) => { if (n === null || !(n > 0)) throw new Error(`${name} must be a positive number`); return n; };
const currencyOf = (v: unknown, dflt: string) => (str(v) || dflt).toUpperCase();

/** Convert one v1 Mongo document into the v2 asset + trade it represents. Throws with a human reason on bad data. */
export function mapV1Row(source: V1Source, raw: unknown, tz: string): MappedRow {
  if (!raw || typeof raw !== "object") throw new Error("row is not an object");
  const d = raw as Doc;
  const key = str(d["_id"]) || JSON.stringify(d);
  switch (source) {
    case "stock-transactions": {
      const currency = currencyOf(d["currency"], "NPR");
      const quantity = positive(numOrNull(d["quantity"]), "quantity");
      const price = positive(numOrNull(d["price"]), "price");
      const symbol = str(d["stockSymbol"]).toUpperCase();
      if (!symbol) throw new Error("stockSymbol is required");
      const total = numOrNull(d["totalAmount"]);
      return {
        asset: { symbol, name: str(d["stockName"]) || symbol, class: "stock", tracking: "units", currency },
        prefersManualCost: d["useForAvgPrice"] === true,
        trade: { type: side(d["type"]) === "BUY" ? "buy" : "sell", quantity, priceMinor: toMinor(price, currency), amountMinor: toMinor(total ?? price * quantity, currency), feeMinor: 0, tradedOn: dateOf(d["investedDate"], tz), note: null, includeInAvg: d["useForAvgPrice"] === true },
        key,
      };
    }
    case "stock-capital": {
      const currency = currencyOf(d["currency"], "NPR");
      return {
        asset: { symbol: "STOCK-CAPITAL", name: "Stock account capital", class: "stock", tracking: "value", currency },
        prefersManualCost: false,
        trade: { type: side(d["type"]) === "BUY" ? "contribution" : "withdrawal", quantity: null, priceMinor: null, amountMinor: toMinor(positive(numOrNull(d["amount"]), "amount"), currency), feeMinor: 0, tradedOn: dateOf(d["date"], tz), note: null, includeInAvg: true },
        key,
      };
    }
    case "coin-capital": {
      const currency = currencyOf(d["currency"], "THB");
      const fee = numOrNull(d["transactionCharge"]) ?? 0;
      return {
        asset: { symbol: "COIN-CAPITAL", name: "Coin capital", class: "crypto", tracking: "value", currency },
        prefersManualCost: false,
        trade: { type: side(d["type"]) === "BUY" ? "contribution" : "withdrawal", quantity: null, priceMinor: null, amountMinor: toMinor(positive(numOrNull(d["amount"]), "amount"), currency), feeMinor: toMinor(Math.max(0, fee), currency), tradedOn: dateOf(d["date"], tz), note: null, includeInAvg: true },
        key,
      };
    }
    case "sip-capital": {
      const currency = currencyOf(d["currency"], "NPR");
      const name = str(d["name"]);
      if (!name) throw new Error("name is required");
      return {
        asset: { symbol: name.toUpperCase().slice(0, 30), name, class: "fund", tracking: "value", currency },
        prefersManualCost: false,
        trade: { type: "contribution", quantity: null, priceMinor: null, amountMinor: toMinor(positive(numOrNull(d["amount"]), "amount"), currency), feeMinor: 0, tradedOn: dateOf(d["date"], tz), note: null, includeInAvg: true },
        key,
      };
    }
    case "ssf-capital": {
      const currency = currencyOf(d["currency"], "NPR");
      const amount = numOrNull(d["amount"]);
      const months = numOrNull(d["monthsPaid"]) ?? 1;
      const total = numOrNull(d["totalAmount"]) ?? (amount !== null ? amount * months : null);
      const extra = str(d["notes"]);
      return {
        asset: { symbol: "SSF", name: "Social Security Fund", class: "retirement", tracking: "value", currency },
        prefersManualCost: false,
        trade: { type: "contribution", quantity: null, priceMinor: null, amountMinor: toMinor(positive(total, "totalAmount"), currency), feeMinor: 0, tradedOn: dateOf(d["paidDate"] ?? d["dateAdded"], tz), note: [`${months} month(s)${amount !== null ? ` × ${amount}` : ""}`, extra].filter(Boolean).join(" — "), includeInAvg: true },
        key,
      };
    }
  }
}
