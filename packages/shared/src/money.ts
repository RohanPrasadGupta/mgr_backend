/** Money is always integer minor units + ISO-4217 code. Never floats. */
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XAF", "XOF"]);

export function minorUnit(code: string): number {
  return ZERO_DECIMAL.has(code.toUpperCase()) ? 0 : 2;
}

export function toMinor(major: number, currency: string): number {
  return Math.round(major * 10 ** minorUnit(currency));
}

export function toMajor(minor: number, currency: string): number {
  return minor / 10 ** minorUnit(currency);
}

/** Convert minor units between currencies. `rate` = units of `to` per 1 unit of `from`. */
export function convertMinor(amountMinor: number, from: string, to: string, rate: number): number {
  if (from === to) return amountMinor;
  if (!Number.isFinite(rate) || rate <= 0) throw new RangeError("fx rate must be a positive number");
  return Math.round(toMajor(amountMinor, from) * rate * 10 ** minorUnit(to));
}

export function formatMoney(amountMinor: number, currency: string, locale = "en"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(toMajor(amountMinor, currency));
}

/** (income − expense) / income × 100, or null when there is no income. Matches v1 thresholds. */
export function savingsRatePct(incomeMinor: number, expenseMinor: number): number | null {
  if (incomeMinor <= 0) return null;
  return ((incomeMinor - expenseMinor) / incomeMinor) * 100;
}

export type SavingsBand = "healthy" | "low" | "overspending" | "none";
export function savingsBand(pct: number | null): SavingsBand {
  if (pct === null) return "none";
  if (pct >= 20) return "healthy";
  if (pct >= 0) return "low";
  return "overspending";
}

/** Annuity-due SIP future value (v1 formula). */
export function sipProjection(monthly: number, annualRatePct: number, years: number) {
  const months = Math.round(years * 12);
  const r = annualRatePct / 12 / 100;
  const fv = (m: number) => (r === 0 ? monthly * m : monthly * (((1 + r) ** m - 1) / r) * (1 + r));
  const totalInvested = monthly * months;
  const maturityValue = fv(months);
  const yearlyBreakdown = Array.from({ length: Math.ceil(months / 12) }, (_, i) => {
    const m = Math.min((i + 1) * 12, months);
    const total = fv(m);
    return { year: i + 1, invested: monthly * m, returns: total - monthly * m, total };
  });
  return { totalInvested, estimatedReturns: maturityValue - totalInvested, maturityValue, yearlyBreakdown };
}
