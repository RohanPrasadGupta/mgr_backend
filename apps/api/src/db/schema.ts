import { sql } from "drizzle-orm";
import {
  bigint, boolean, check, date, doublePrecision, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid,
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
export const debtDirection = pgEnum("debt_direction", ["lent", "borrowed"]);

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
  /** The currencies this user works with, shown first in every currency picker (the base currency is always included). */
  currencies: text("currencies").array().notNull().default(sql`'{}'::text[]`),
  timezone: text("timezone").notNull().default("UTC"),
  locale: text("locale").notNull().default("en"),
  weekStart: integer("week_start").notNull().default(1),
  emailVerifiedAt: ts("email_verified_at"),
  passwordChangedAt: ts("password_changed_at"),
  /** Set by an admin: sign-in, token refresh and every API call are refused until reactivated. */
  suspendedAt: ts("suspended_at"),
  suspendedReason: text("suspended_reason"),
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
    /**
     * Optional user-entered conversion: amounts stay in `currency`, but totals count this asset in `convertCurrency`
     * at `convertRate` (1 unit of `currency` = convertRate units of `convertCurrency`) instead of the daily FX rate.
     */
    convertCurrency: text("convert_currency").references(() => currencies.code),
    convertRate: doublePrecision("convert_rate"),
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

/** User-defined labels; many-to-many with transactions (a transaction can carry several, e.g. "trip-2026", "work"). */
export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tags_user_name_uq").on(t.userId, sql`lower(${t.name})`)],
);

export const transactionTags = pgTable(
  "transaction_tags",
  {
    transactionId: uuid("transaction_id").notNull().references(() => transactions.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("transaction_tags_pk").on(t.transactionId, t.tagId), index("transaction_tags_tag_idx").on(t.tagId)],
);

/** Receipts/invoices attached to a transaction. Bytes live in Storage under `storageKey`; this row is the index. */
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    transactionId: uuid("transaction_id").notNull().references(() => transactions.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("attachments_tx_idx").on(t.transactionId), index("attachments_user_idx").on(t.userId)],
);

/** A savings target. Progress = linked account balance, or the sum of manual contributions when no account is linked. */
export const goals = pgTable(
  "goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    targetMinor: money("target_minor").notNull(),
    currency: text("currency").notNull().references(() => currencies.code),
    targetDate: date("target_date", { mode: "string" }),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    icon: text("icon"),
    color: text("color"),
    note: text("note"),
    archived: boolean("archived").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [check("goals_target_positive", sql`${t.targetMinor} > 0`), index("goals_user_idx").on(t.userId)],
);

export const goalContributions = pgTable(
  "goal_contributions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
    /** Positive = saved toward the goal, negative = taken out. */
    amountMinor: money("amount_minor").notNull(),
    occurredOn: date("occurred_on", { mode: "string" }).notNull(),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [check("goal_contrib_nonzero", sql`${t.amountMinor} <> 0`), index("goal_contrib_goal_idx").on(t.goalId, t.occurredOn)],
);

/** Money lent to or borrowed from someone, tracked outside the ledger. Outstanding = principal − payments. */
export const debts = pgTable(
  "debts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    direction: debtDirection("direction").notNull(),
    counterparty: text("counterparty").notNull(),
    principalMinor: money("principal_minor").notNull(),
    currency: text("currency").notNull().references(() => currencies.code),
    startedOn: date("started_on", { mode: "string" }).notNull(),
    dueOn: date("due_on", { mode: "string" }),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [check("debts_principal_positive", sql`${t.principalMinor} > 0`), index("debts_user_idx").on(t.userId)],
);

export const debtPayments = pgTable(
  "debt_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    debtId: uuid("debt_id").notNull().references(() => debts.id, { onDelete: "cascade" }),
    amountMinor: money("amount_minor").notNull(),
    paidOn: date("paid_on", { mode: "string" }).notNull(),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [check("debt_payments_positive", sql`${t.amountMinor} > 0`), index("debt_payments_debt_idx").on(t.debtId, t.paidOn)],
);

export const notes = pgTable(
  "notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("notes_user_idx").on(t.userId, t.pinned, t.updatedAt)],
);

// ── admin (separate from customer accounts: own logins, 2FA, sessions, audit log) ──

export const admins = pgTable("admins", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  /** owner = can also add, disable and reset other admins (the Admins page); admin = support tools only. */
  role: text("role", { enum: ["owner", "admin"] }).notNull().default("admin"),
  /** Set when an owner issues a one-time password: every admin route except changing it is refused until it's changed. */
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  /** Authenticator-app secret, AES-256-GCM encrypted (never stored or logged in plain text). Confirmed once `totpEnabledAt` is set. */
  totpSecretEnc: text("totp_secret_enc"),
  totpEnabledAt: ts("totp_enabled_at"),
  lastLoginAt: ts("last_login_at"),
  disabledAt: ts("disabled_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adminId: uuid("admin_id").notNull().references(() => admins.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("admin_sessions_admin_idx").on(t.adminId)],
);

/** Every admin sign-in, view and action. Target users are referenced by id + email snapshot (no FK: entries outlive deleted users). */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adminId: uuid("admin_id").references(() => admins.id, { onDelete: "set null" }),
    adminEmail: text("admin_email"),
    action: text("action").notNull(),
    targetUserId: uuid("target_user_id"),
    targetEmail: text("target_email"),
    reason: text("reason"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    ip: text("ip"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("audit_log_created_idx").on(t.createdAt), index("audit_log_target_idx").on(t.targetUserId, t.createdAt), index("audit_log_admin_idx").on(t.adminId, t.createdAt)],
);
