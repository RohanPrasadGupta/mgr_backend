import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { and, desc, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { CONFIG, DB, type Db } from "../../db/db";
import type { Config } from "../../config";
import { currencies, fxRates } from "../../db/schema";
import { AppError } from "../../common/errors";

const providerSchema = z.object({
  result: z.literal("success"),
  time_last_update_unix: z.number(),
  rates: z.record(z.string(), z.number().positive()),
});

export interface FxQuote { from: string; to: string; rate: number; asOf: string; approximate: boolean }

const REFRESH_EVERY_MS = 12 * 3600_000;

@Injectable()
export class FxService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger("Fx");
  private timer?: NodeJS.Timeout;
  constructor(@Inject(DB) private readonly db: Db, @Inject(CONFIG) private readonly config: Config) {}

  onApplicationBootstrap() {
    if (!this.config.FX_AUTO_REFRESH) return;
    const run = () => this.refresh().catch((e) => this.log.warn(`FX refresh failed: ${e instanceof Error ? e.message : e}`));
    void run();
    this.timer = setInterval(run, REFRESH_EVERY_MS);
    this.timer.unref();
  }
  onApplicationShutdown() { clearInterval(this.timer); }

  /** Pull latest daily rates (open.er-api.com, USD base) for every supported currency. */
  async refresh(fetchFn: typeof fetch = fetch): Promise<{ asOf: string; count: number }> {
    const res = await fetchFn(this.config.FX_PROVIDER_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`provider responded ${res.status}`);
    const body = providerSchema.parse(await res.json());
    const asOf = new Date(body.time_last_update_unix * 1000).toISOString().slice(0, 10);
    const supported = await this.db.select({ code: currencies.code }).from(currencies);
    const rows = supported
      .filter((c) => c.code !== "USD" && body.rates[c.code] !== undefined)
      .map((c) => ({ base: "USD", quote: c.code, rate: String(body.rates[c.code]), asOf, source: "open.er-api.com" }));
    if (rows.length === 0) throw new Error("provider returned no supported currencies");
    await this.db.insert(fxRates).values(rows).onConflictDoUpdate({ target: [fxRates.base, fxRates.quote, fxRates.asOf], set: { rate: sql`excluded.rate` } });
    this.log.log(`stored ${rows.length} rates as of ${asOf}`);
    return { asOf, count: rows.length };
  }

  /** USD→code for the latest day ≤ date; falls back to the earliest known day (flagged approximate). */
  private async usdRates(codes: string[], date: string) {
    const out = new Map<string, { rate: number; asOf: string; approximate: boolean }>([]);
    const need = codes.filter((c) => c !== "USD");
    if (need.length === 0) return out;
    const exact = await this.db
      .selectDistinctOn([fxRates.quote], { quote: fxRates.quote, rate: fxRates.rate, asOf: fxRates.asOf })
      .from(fxRates)
      .where(and(inArray(fxRates.quote, need), lte(fxRates.asOf, date)))
      .orderBy(fxRates.quote, desc(fxRates.asOf));
    for (const r of exact) out.set(r.quote, { rate: Number(r.rate), asOf: r.asOf, approximate: false });
    const missing = need.filter((c) => !out.has(c));
    if (missing.length) {
      const early = await this.db
        .selectDistinctOn([fxRates.quote], { quote: fxRates.quote, rate: fxRates.rate, asOf: fxRates.asOf })
        .from(fxRates)
        .where(inArray(fxRates.quote, missing))
        .orderBy(fxRates.quote, fxRates.asOf);
      for (const r of early) out.set(r.quote, { rate: Number(r.rate), asOf: r.asOf, approximate: true });
    }
    return out;
  }

  /** Rate such that amount_in_`to` = amount_in_`from` × rate. Null when either currency has no stored rate. */
  async getRate(from: string, to: string, date: string): Promise<FxQuote | null> {
    if (from === to) return { from, to, rate: 1, asOf: date, approximate: false };
    const m = await this.usdRates([from, to], date);
    const f = from === "USD" ? { rate: 1, asOf: date, approximate: false } : m.get(from);
    const t = to === "USD" ? { rate: 1, asOf: date, approximate: false } : m.get(to);
    if (!f || !t) return null;
    return { from, to, rate: t.rate / f.rate, asOf: f.asOf < t.asOf ? f.asOf : t.asOf, approximate: f.approximate || t.approximate };
  }

  async requireRate(from: string, to: string, date: string): Promise<FxQuote> {
    const q = await this.getRate(from, to, date);
    if (!q) throw new AppError(422, "fx_rate_required", `No FX rate available for ${from}→${to}; supply fxRate`);
    return q;
  }
}
