import { sql } from "drizzle-orm";
import {
  bigint, boolean, check, date, index, integer, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const money = (name: string) => bigint(name, { mode: "number" });
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const accountType = pgEnum("account_type", ["cash", "bank", "wallet", "card", "loan", "investment"]);
export const categoryKind = pgEnum("category_kind", ["income", "expense"]);
export const txKind = pgEnum("tx_kind", ["income", "expense", "transfer_out", "transfer_in"]);
export const assetClass = pgEnum("asset_class", ["stock", "crypto", "fund", "retirement", "gold", "fixed_deposit", "other"]);
export const costMethod = pgEnum("cost_method", ["wavg", "fifo", "manual"]);
export const tradeType = pgEnum("trade_type", ["buy", "sell", "dividend", "bonus", "fee", "contribution", "withdrawal"]);
export const tracking = pgEnum("tracking", ["units", "value"]);
export const budgetPeriod = pgEnum("budget_period", ["month", "week", "custom"]);
export const recurFrequency = pgEnum("recur_frequency", ["daily", "weekly", "monthly", "yearly"]);

export const currencies = pgTable("currencies", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  symbol: text("symbol").notNull(),
  minorUnit: integer("minor_unit").notNull().default(2),
});

/** Daily USD-based rates (units of `quote` per 1 USD); cross rates are derived. */
export const fxRates = pgTable(
  "fx_rates",
  {
    base: text("base").notNull().default("USD"),
    quote: text("quote").notNull().references(() => currencies.code),
    rate: numeric("rate", { precision: 24, scale: 10 }).notNull(),
    asOf: date("as_of", { mode: "string" }).notNull(),
    source: text("source").notNull(),
  },
  (t) => [uniqueIndex("fx_rates_pk").on(t.base, t.quote, t.asOf), index("fx_rates_quote_asof_idx").on(t.quote, t.asOf.desc())],
);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  baseCurrency: text("base_currency").notNull().references(() => currencies.code).default("THB"),
  timezone: text("timezone").notNull().default("UTC"),
  locale: text("locale").notNull().default("en"),
  weekStart: integer("week_start").notNull().default(1),
  createdAt: ts("created_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
});

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    familyId: uuid("family_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    userAgent: text("user_agent"),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("refresh_tokens_user_idx").on(t.userId), index("refresh_tokens_family_idx").on(t.familyId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: accountType("type").notNull(),
    currency: text("currency").notNull().references(() => currencies.code),
    openingBalanceMinor: money("opening_balance_minor").notNull().default(0),
    includeInNetWorth: boolean("include_in_net_worth").notNull().default(true),
    archived: boolean("archived").notNull().default(false),
    icon: text("icon"),
    color: text("color"),
    sort: integer("sort").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [uniqueIndex("accounts_user_name_uq").on(t.userId, t.name).where(sql`${t.deletedAt} is null`)],
);

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => categories.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    kind: categoryKind("kind").notNull(),
    icon: text("icon"),
    color: text("color"),
    archived: boolean("archived").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [uniqueIndex("categories_user_kind_name_uq").on(t.userId, t.kind, t.name).where(sql`${t.deletedAt} is null`)],
);

export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => categories.id), // null = overall expense budget
    period: budgetPeriod("period").notNull(),
    amountMinor: money("amount_minor").notNull(),
    currency: text("currency").notNull().references(() => currencies.code), // user's base currency at creation
    startOn: date("start_on", { mode: "string" }).notNull(),
    endOn: date("end_on", { mode: "string" }),
    alertThresholdPct: integer("alert_threshold_pct").notNull().default(80),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [check("budgets_amount_positive", sql`${t.amountMinor} > 0`), index("budgets_user_idx").on(t.userId)],
);

export const recurringRules = pgTable(
  "recurring_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    categoryId: uuid("category_id").references(() => categories.id),
    kind: categoryKind("kind").notNull(),
    amountMinor: money("amount_minor").notNull(),
    note: text("note"),
    frequency: recurFrequency("frequency").notNull(),
    interval: integer("interval").notNull().default(1),
    startOn: date("start_on", { mode: "string" }).notNull(),
    endOn: date("end_on", { mode: "string" }),
    nextRunOn: date("next_run_on", { mode: "string" }).notNull(),
    lastRunOn: date("last_run_on", { mode: "string" }),
    lastError: text("last_error"),
    active: boolean("active").notNull().default(true),
    createdAt: ts("created_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [check("recurring_amount_positive", sql`${t.amountMinor} > 0`), index("recurring_due_idx").on(t.active, t.nextRunOn)],
);

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull().references(() => accounts.id),
    categoryId: uuid("category_id").references(() => categories.id),
    kind: txKind("kind").notNull(),
    amountMinor: money("amount_minor").notNull(),
    currency: text("currency").notNull().references(() => currencies.code),
    fxRate: numeric("fx_rate", { precision: 24, scale: 10 }).notNull().default("1"),
    baseAmountMinor: money("base_amount_minor").notNull(),
    occurredAt: ts("occurred_at").notNull(),
    occurredOn: date("occurred_on", { mode: "string" }).notNull(),
    note: text("note"),
    transferGroupId: uuid("transfer_group_id"),
    clientId: uuid("client_id"),
    recurringId: uuid("recurring_id").references(() => recurringRules.id),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    check("transactions_amount_positive", sql`${t.amountMinor} > 0`),
    index("transactions_user_date_idx").on(t.userId, t.occurredOn.desc()),
    index("transactions_user_account_idx").on(t.userId, t.accountId),
    index("transactions_transfer_idx").on(t.transferGroupId),
    uniqueIndex("transactions_user_client_uq").on(t.userId, t.clientId).where(sql`${t.clientId} is not null`),
  ],
);

export type User = typeof users.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;

/** One row per instrument or pool the user holds (a stock, a SIP fund, SSF…). Positions are derived from `trades`. */
export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    name: text("name").notNull(),
    class: assetClass("class").notNull(),
    currency: text("currency").notNull().references(() => currencies.code),
    tracking: tracking("tracking").notNull(),
    costMethod: costMethod("cost_method").notNull().default("wavg"),
    archived: boolean("archived").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [uniqueIndex("assets_user_class_symbol_uq").on(t.userId, t.class, t.symbol).where(sql`${t.deletedAt} is null`)],
);

export const trades = pgTable(
  "trades",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull().references(() => assets.id),
    type: tradeType("type").notNull(),
    quantity: numeric("quantity", { precision: 28, scale: 10 }),
    priceMinor: numeric("price_minor", { precision: 28, scale: 6 }),
    amountMinor: money("amount_minor").notNull(),
    feeMinor: money("fee_minor").notNull().default(0),
    tradedOn: date("traded_on", { mode: "string" }).notNull(),
    note: text("note"),
    includeInAvg: boolean("include_in_avg").notNull().default(true),
    clientId: uuid("client_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    check("trades_amounts_nonneg", sql`${t.amountMinor} >= 0 and ${t.feeMinor} >= 0`),
    index("trades_user_asset_idx").on(t.userId, t.assetId, t.tradedOn),
    uniqueIndex("trades_user_client_uq").on(t.userId, t.clientId).where(sql`${t.clientId} is not null`),
  ],
);

/** Manually entered or fetched prices. Units assets: price per unit. Value assets: total current value. */
export const assetPrices = pgTable(
  "asset_prices",
  {
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    asOn: date("as_on", { mode: "string" }).notNull(),
    priceMinor: numeric("price_minor", { precision: 28, scale: 6 }).notNull(),
    source: text("source").notNull().default("manual"),
  },
  (t) => [uniqueIndex("asset_prices_pk").on(t.assetId, t.asOn)],
);
