import { sql } from "drizzle-orm";
import type { Db } from "../../db/db";

type Exec = Pick<Db, "execute">;

/**
 * Adds a currency to the user's own list (no-op when it's already there). Called wherever something is created in a
 * currency — an account, asset, debt or import — so picking "another currency" once keeps it in the list from then on.
 */
export async function rememberCurrency(db: Exec, userId: string, code: string) {
  await db.execute(sql`update users set currencies = array_append(currencies, ${code}) where id = ${userId} and not (${code} = any(currencies))`);
}

/** The list as shown to the user: base currency first, then the rest in the order they were added. */
export const userCurrencies = (u: { baseCurrency: string; currencies: string[] }) => [u.baseCurrency, ...u.currencies.filter((c) => c !== u.baseCurrency)];
