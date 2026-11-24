/** Calendar date (YYYY-MM-DD) of an instant in an IANA timezone. Used for month/year bucketing. */
export function toLocalDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function monthRange(year: number, month: number): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(last)}` };
}

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function tzOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(instant));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(instant / 1000) * 1000;
}

/**
 * Parse a date-time string. Strings with an explicit offset/Z are taken as-is; naive ones
 * ("2025-08-26", "2025-08-26 13:05", "2025-08-26T13:05:09") are read as wall-clock time in `timeZone`.
 */
export function parseInTimeZone(input: string, timeZone: string): Date | null {
  const s = input.trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s) && /T/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return null;
  const [y, mo, d, h = 0, mi = 0, se = 0] = m.slice(1).map((v) => (v === undefined ? 0 : Number(v)));
  const naive = Date.UTC(y!, mo! - 1, d!, h, mi, se);
  if (new Date(naive).getUTCMonth() !== mo! - 1) return null; // e.g. Feb 31
  let guess = naive - tzOffsetMs(naive, timeZone);
  guess = naive - tzOffsetMs(guess, timeZone); // second pass handles DST edges
  return new Date(guess);
}

// ---- calendar arithmetic on YYYY-MM-DD strings (UTC math, no timezone drift) ----
const ymd = (s: string) => { const [y, m, d] = s.split("-").map(Number); return { y: y!, m: m!, d: d! }; };
const fmt = (y: number, m: number, d: number) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function addDays(date: string, n: number): string {
  const { y, m, d } = ymd(date);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
/** Add months keeping `anchorDay`, clamped to month length (Jan 31 → Feb 28 → Mar 31). */
export function addMonthsClamped(date: string, months: number, anchorDay: number): string {
  const { y, m } = ymd(date);
  const idx = y * 12 + (m - 1) + months;
  const ny = Math.floor(idx / 12), nm = (idx % 12) + 1;
  return fmt(ny, nm, Math.min(anchorDay, daysInMonth(ny, nm)));
}
export const dayOfWeek = (date: string) => { const { y, m, d } = ymd(date); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

export type Frequency = "daily" | "weekly" | "monthly" | "yearly";
/** The occurrence after `current`. `anchorDay` is the day-of-month of the series start (for month-end clamping). */
export function nextOccurrence(current: string, frequency: Frequency, interval: number, anchorDay: number): string {
  switch (frequency) {
    case "daily": return addDays(current, interval);
    case "weekly": return addDays(current, 7 * interval);
    case "monthly": return addMonthsClamped(current, interval, anchorDay);
    case "yearly": return addMonthsClamped(current, 12 * interval, anchorDay);
  }
}
/** First occurrence of the series (anchored at `startOn`) that is on or after `onOrAfter`. */
export function firstOccurrenceOnOrAfter(startOn: string, frequency: Frequency, interval: number, onOrAfter: string): string {
  const anchor = ymd(startOn).d;
  let cur = startOn;
  for (let i = 0; cur < onOrAfter && i < 100_000; i++) cur = nextOccurrence(cur, frequency, interval, anchor);
  return cur;
}
export function previewOccurrences(next: string, frequency: Frequency, interval: number, anchorDay: number, count: number, endOn?: string | null): string[] {
  const out: string[] = [];
  for (let cur = next; out.length < count && (!endOn || cur <= endOn); cur = nextOccurrence(cur, frequency, interval, anchorDay)) out.push(cur);
  return out;
}

export type BudgetPeriod = "month" | "week" | "custom";
/** The date window a budget covers on `onDate`, or null if the budget is not active then. */
export function budgetWindow(period: BudgetPeriod, onDate: string, weekStart: number, startOn: string, endOn?: string | null): { from: string; to: string } | null {
  if (endOn && onDate > endOn) return null;
  if (period === "custom") return endOn && onDate >= startOn ? { from: startOn, to: endOn } : null;
  let w: { from: string; to: string };
  if (period === "month") {
    const { y, m } = ymd(onDate);
    w = { from: fmt(y, m, 1), to: fmt(y, m, daysInMonth(y, m)) };
  } else {
    const from = addDays(onDate, -((dayOfWeek(onDate) - weekStart + 7) % 7));
    w = { from, to: addDays(from, 6) };
  }
  return w.to < startOn ? null : w; // not started yet
}
