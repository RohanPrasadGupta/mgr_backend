import { z } from "zod";
import { accountTypes } from "../schemas/ledger";
import { assetClasses, tradeTypes } from "../schemas/investments";
import { debtDirections } from "../schemas/planning";

/**
 * Response contracts. These are `strictObject`s on purpose: the API's integration tests validate every real
 * response against them, so a field added to (or dropped from) an endpoint fails CI until the contract is updated.
 * Named schemas (`.meta({ id })`) become `components.schemas` in the generated OpenAPI document.
 */
const uuid = z.uuid();
const dateTime = z.iso.datetime();
const date = z.iso.date();
const money = z.number().int();
const nullableString = z.string().nullable();
const named = <T extends z.ZodType>(id: string, s: T) => s.meta({ id }) as T;
const obj = z.strictObject;

export const ErrorBody = named("ErrorBody", obj({ error: obj({ code: z.string(), message: z.string(), details: z.unknown().optional() }) }));

export const User = named("User", obj({ id: uuid, email: z.email(), name: z.string(), baseCurrency: z.string(), timezone: z.string(), locale: z.string(), weekStart: z.number().int(), emailVerified: z.boolean() }));
export const TokenPair = named("TokenPair", obj({ accessToken: z.string(), refreshToken: z.string(), expiresIn: z.number().int() }));
export const AuthResult = named("AuthResult", obj({ user: User, accessToken: z.string(), refreshToken: z.string(), expiresIn: z.number().int() }));
export const Currency = named("Currency", obj({ code: z.string(), name: z.string(), symbol: z.string(), minorUnit: z.number().int() }));

export const Account = named("Account", obj({
  id: uuid, userId: uuid, name: z.string(), type: z.enum(accountTypes), currency: z.string(), openingBalanceMinor: money, includeInNetWorth: z.boolean(), archived: z.boolean(),
  icon: nullableString, color: nullableString, sort: z.number().int(), createdAt: dateTime, updatedAt: dateTime, deletedAt: dateTime.nullable(), balanceMinor: money,
}));
export const Category = named("Category", obj({
  id: uuid, userId: uuid, parentId: uuid.nullable(), name: z.string(), kind: z.enum(["income", "expense"]), icon: nullableString, color: nullableString, archived: z.boolean(), createdAt: dateTime, deletedAt: dateTime.nullable(),
}));
export const Transaction = named("Transaction", obj({
  id: uuid, userId: uuid, accountId: uuid, categoryId: uuid.nullable(), kind: z.enum(["income", "expense", "transfer_out", "transfer_in"]), amountMinor: money, currency: z.string(),
  fxRate: z.number(), baseAmountMinor: money, occurredAt: dateTime, occurredOn: date, note: nullableString, transferGroupId: uuid.nullable(), clientId: uuid.nullable(), recurringId: uuid.nullable(),
  createdAt: dateTime, updatedAt: dateTime, deletedAt: dateTime.nullable(), version: z.number().int(),
  tagIds: z.array(uuid), attachmentCount: z.number().int(),
}));
export const TransferResult = named("TransferResult", obj({ transferGroupId: uuid, legs: z.array(Transaction) }));

export const Summary = named("Summary", obj({
  from: date, to: date, baseCurrency: z.string(), incomeMinor: money, expenseMinor: money, netMinor: money,
  savingsRatePct: z.number().nullable(), savingsBand: z.enum(["healthy", "low", "overspending", "none"]), transactionCount: z.number().int(),
}));
export const ByCategory = named("ByCategory", obj({
  from: date, to: date, kind: z.enum(["income", "expense"]), baseCurrency: z.string(), totalMinor: money,
  items: z.array(obj({ categoryId: uuid.nullable(), name: z.string(), totalMinor: money, count: z.number().int(), pct: z.number() })),
}));
export const Trend = named("Trend", obj({ year: z.number().int(), baseCurrency: z.string(), incomeMinor: z.array(money).length(12), expenseMinor: z.array(money).length(12), netMinor: z.array(money).length(12), cumulativeNetMinor: z.array(money).length(12) }));

export const Daily = named("Daily", obj({ from: date, to: date, baseCurrency: z.string(), days: z.array(obj({ date, incomeMinor: money, expenseMinor: money })) }));

const budgetPeriod = z.enum(["month", "week", "custom"]);
export const Budget = named("Budget", obj({
  id: uuid, userId: uuid, categoryId: uuid.nullable(), period: budgetPeriod, amountMinor: money, currency: z.string(), startOn: date, endOn: date.nullable(),
  alertThresholdPct: z.number().int(), createdAt: dateTime, categoryName: nullableString.optional(),
}));
export const BudgetStatusItem = named("BudgetStatusItem", obj({
  id: uuid, userId: uuid, categoryId: uuid.nullable(), period: budgetPeriod, amountMinor: money, currency: z.string(), startOn: date, endOn: date.nullable(), alertThresholdPct: z.number().int(), createdAt: dateTime,
  categoryName: nullableString, window: obj({ from: date, to: date }), spentMinor: money, remainingMinor: money, pct: z.number(), state: z.enum(["ok", "warning", "over"]),
}));
export const BudgetStatus = named("BudgetStatus", obj({ date, baseCurrency: z.string(), items: z.array(BudgetStatusItem) }));

export const RecurringRule = named("RecurringRule", obj({
  id: uuid, userId: uuid, accountId: uuid, categoryId: uuid.nullable(), kind: z.enum(["income", "expense"]), amountMinor: money, note: nullableString,
  frequency: z.enum(["daily", "weekly", "monthly", "yearly"]), interval: z.number().int(), startOn: date, endOn: date.nullable(), nextRunOn: date, lastRunOn: date.nullable(),
  lastError: nullableString, active: z.boolean(), createdAt: dateTime, deletedAt: dateTime.nullable(), nextDates: z.array(date),
}));
export const RunReport = named("RunReport", obj({ rules: z.number().int(), posted: z.number().int(), errors: z.array(obj({ ruleId: uuid, error: z.string() })) }));
export const FxQuote = named("FxQuote", obj({ from: z.string(), to: z.string(), rate: z.number(), asOf: date, approximate: z.boolean() }));

const invalidRows = z.array(obj({ row: z.number().int(), reason: z.string() }));
export const ImportReport = named("ImportReport", obj({
  dryRun: z.boolean(), total: z.number().int(), imported: z.number().int(), duplicates: z.number().int(), invalid: invalidRows,
  createdAccounts: z.array(z.string()), createdCategories: z.array(z.string()), approximateFxRows: z.number().int(),
}));
export const InvestmentImportReport = named("InvestmentImportReport", obj({
  source: z.string(), dryRun: z.boolean(), total: z.number().int(), imported: z.number().int(), duplicates: z.number().int(), invalid: invalidRows,
  createdAssets: z.array(z.string()), positionErrors: z.array(obj({ symbol: z.string(), message: z.string() })),
}));

export const Asset = named("Asset", obj({
  id: uuid, userId: uuid, symbol: z.string(), name: z.string(), class: z.enum(assetClasses), currency: z.string(), tracking: z.enum(["units", "value"]),
  costMethod: z.enum(["wavg", "fifo", "manual"]), archived: z.boolean(), createdAt: dateTime, deletedAt: dateTime.nullable(),
}));
export const Holding = named("Holding", obj({
  asset: Asset, quantity: z.number(), avgCostMinor: z.number().nullable(), remainingCostMinor: money, totalBoughtMinor: money, totalSoldMinor: money, contributedMinor: money, withdrawnMinor: money,
  feesMinor: money, dividendsMinor: money, realisedPnlMinor: money, latestPrice: obj({ asOn: date, priceMinor: z.number() }).nullable(), marketValueMinor: money.nullable(),
  unrealisedPnlMinor: money.nullable(), returnPct: z.number().nullable(), xirrPct: z.number().nullable(), closed: z.boolean(), tradeCount: z.number().int(), firstTradedOn: date.nullable(), lastTradedOn: date.nullable(),
}));
export const Portfolio = named("Portfolio", obj({
  baseCurrency: z.string(), asOf: date, investedMinor: money, marketValueMinor: money, unrealisedPnlMinor: money, realisedPnlMinor: money, dividendsMinor: money,
  xirrPct: z.number().nullable(), approximate: z.boolean(), pricedAll: z.boolean(),
  allocation: z.array(obj({ class: z.enum(assetClasses), valueMinor: money, pct: z.number() })), holdings: z.array(Holding),
  excluded: z.array(obj({ assetId: uuid, symbol: z.string(), reason: z.string() })),
}));
export const Trade = named("Trade", obj({
  id: uuid, userId: uuid, assetId: uuid, type: z.enum(tradeTypes), quantity: z.number().nullable(), priceMinor: z.number().nullable(), amountMinor: money, feeMinor: money,
  tradedOn: date, note: nullableString, includeInAvg: z.boolean(), clientId: uuid.nullable(), createdAt: dateTime, deletedAt: dateTime.nullable(),
}));
export const PricePoint = named("PricePoint", obj({ asOn: date, priceMinor: z.number(), source: z.string() }));
export const PriceSet = named("PriceSet", obj({ assetId: uuid, asOn: date, priceMinor: z.number() }));
export const SipResult = named("SipResult", obj({
  totalInvested: z.number(), estimatedReturns: z.number(), maturityValue: z.number(),
  yearlyBreakdown: z.array(obj({ year: z.number().int(), invested: z.number(), returns: z.number(), total: z.number() })),
}));

export const Accepted = named("Accepted", obj({ accepted: z.literal(true) }));
export const Verified = named("Verified", obj({ verified: z.literal(true) }));

export const Tag = named("Tag", obj({ id: uuid, userId: uuid, name: z.string(), color: nullableString, createdAt: dateTime, usageCount: z.number().int() }));
export const Attachment = named("Attachment", obj({ id: uuid, transactionId: uuid, fileName: z.string(), contentType: z.string(), sizeBytes: z.number().int(), createdAt: dateTime }));

export const GoalContribution = named("GoalContribution", obj({ id: uuid, goalId: uuid, amountMinor: money, occurredOn: date, note: nullableString, createdAt: dateTime }));
export const Goal = named("Goal", obj({
  id: uuid, userId: uuid, name: z.string(), targetMinor: money, currency: z.string(), targetDate: date.nullable(), accountId: uuid.nullable(), icon: nullableString, color: nullableString,
  note: nullableString, archived: z.boolean(), createdAt: dateTime, updatedAt: dateTime,
  /** Where progress comes from: the linked account's balance, or manual contributions. */
  source: z.enum(["account", "contributions"]), savedMinor: money, remainingMinor: money, pct: z.number(),
  /** Needed per month from now to hit the target on time (null without a target date or once reached). */
  monthlyNeededMinor: money.nullable(), status: z.enum(["reached", "on_track", "behind", "no_deadline", "overdue"]),
}));
export const GoalDetail = named("GoalDetail", obj({ goal: Goal, contributions: z.array(GoalContribution) }));

export const DebtPayment = named("DebtPayment", obj({ id: uuid, debtId: uuid, amountMinor: money, paidOn: date, note: nullableString, createdAt: dateTime }));
export const Debt = named("Debt", obj({
  id: uuid, userId: uuid, direction: z.enum(debtDirections), counterparty: z.string(), principalMinor: money, currency: z.string(), startedOn: date, dueOn: date.nullable(), note: nullableString,
  createdAt: dateTime, updatedAt: dateTime, paidMinor: money, outstandingMinor: money, status: z.enum(["open", "overdue", "settled"]), lastPaidOn: date.nullable(),
}));
export const DebtDetail = named("DebtDetail", obj({ debt: Debt, payments: z.array(DebtPayment) }));
export const DebtSummary = named("DebtSummary", obj({
  totals: z.array(obj({ currency: z.string(), owedToMeMinor: money, iOweMinor: money, netMinor: money })),
  openCount: z.number().int(), overdueCount: z.number().int(),
}));

export const Note = named("Note", obj({ id: uuid, userId: uuid, title: z.string(), body: z.string(), pinned: z.boolean(), createdAt: dateTime, updatedAt: dateTime }));

const reportCat = obj({ categoryId: uuid.nullable(), name: z.string(), totalMinor: money, pct: z.number(), previousMinor: money, changePct: z.number().nullable() });
export const Report = named("Report", obj({
  period: z.enum(["month", "year"]), label: z.string(), from: date, to: date, previousFrom: date, previousTo: date, baseCurrency: z.string(),
  incomeMinor: money, expenseMinor: money, netMinor: money, savingsRatePct: z.number().nullable(), transactionCount: z.number().int(),
  previous: obj({ incomeMinor: money, expenseMinor: money, netMinor: money }),
  /** Daily average spending across the period's days that have already happened. */
  avgDailyExpenseMinor: money,
  expenseByCategory: z.array(reportCat), incomeByCategory: z.array(reportCat),
  /** Months for a yearly report, days for a monthly one. */
  series: z.array(obj({ label: z.string(), from: date, to: date, incomeMinor: money, expenseMinor: money })),
  topExpenses: z.array(obj({ id: uuid, occurredOn: date, amountMinor: money, currency: z.string(), baseAmountMinor: money, categoryName: nullableString, note: nullableString, accountName: z.string() })),
  byAccount: z.array(obj({ accountId: uuid, name: z.string(), currency: z.string(), incomeMinor: money, expenseMinor: money })),
  budgets: z.array(obj({ id: uuid, categoryName: nullableString, amountMinor: money, spentMinor: money, pct: z.number(), state: z.enum(["ok", "warning", "over"]) })),
}));

/** `{ data: T }` envelope used by every success response. */
export const envelope = <T extends z.ZodType>(data: T) => obj({ data });
export const TransactionPage = named("TransactionPage", obj({ data: z.array(Transaction), meta: obj({ nextCursor: z.string().nullable() }) }));
