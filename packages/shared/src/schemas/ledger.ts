import { z } from "zod";
import { amountMinor, currencyCode, isoDate, kindEnum, uuid } from "./common";

export const accountTypes = ["cash", "bank", "wallet", "card", "loan", "investment"] as const;

export const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(60),
  type: z.enum(accountTypes),
  currency: currencyCode,
  openingBalanceMinor: z.number().int().default(0),
  includeInNetWorth: z.boolean().default(true),
  icon: z.string().max(40).optional(),
  color: z.string().max(20).optional(),
});
export const updateAccountSchema = createAccountSchema
  .omit({ currency: true, openingBalanceMinor: true })
  .extend({ archived: z.boolean(), sort: z.number().int(), openingBalanceMinor: z.number().int() })
  .partial();

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: kindEnum,
  parentId: uuid.optional(),
  icon: z.string().max(40).optional(),
  color: z.string().max(20).optional(),
});
export const updateCategorySchema = createCategorySchema.omit({ kind: true }).extend({ archived: z.boolean() }).partial();

const fxRate = z.number().positive().max(1e9);

export const createTransactionSchema = z.object({
  accountId: uuid,
  kind: kindEnum,
  amountMinor,
  categoryId: uuid.optional(),
  occurredAt: z.coerce.date().optional(),
  note: z.string().max(500).optional(),
  fxRate: fxRate.optional(),
  clientId: uuid.optional(),
});
export const updateTransactionSchema = z
  .object({
    amountMinor,
    categoryId: uuid.nullable(),
    occurredAt: z.coerce.date(),
    note: z.string().max(500).nullable(),
    fxRate,
  })
  .partial();

export const listTransactionsSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  accountId: uuid.optional(),
  categoryId: uuid.optional(),
  kind: z.enum(["income", "expense", "transfer_out", "transfer_in"]).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  minMinor: z.coerce.number().int().optional(),
  maxMinor: z.coerce.number().int().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const createTransferSchema = z.object({
  fromAccountId: uuid,
  toAccountId: uuid,
  amountMinor,
  toAmountMinor: amountMinor.optional(),
  occurredAt: z.coerce.date().optional(),
  note: z.string().max(500).optional(),
  fxRate: fxRate.optional(),
});

export const rangeQuerySchema = z.object({ from: isoDate, to: isoDate });
export const byCategoryQuerySchema = rangeQuerySchema.extend({ kind: kindEnum.default("expense") });
export const trendQuerySchema = z.object({ year: z.coerce.number().int().min(1970).max(2200) });

export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;
export type ListTransactionsInput = z.infer<typeof listTransactionsSchema>;
export type CreateTransferInput = z.infer<typeof createTransferSchema>;

export const importRowSchema = z.object({
  date: z.string().min(8).max(40),
  account: z.string().trim().min(1).max(60),
  category: z.string().trim().max(80).default(""),
  note: z.string().max(500).optional().default(""),
  currency: currencyCode,
  amount: z.number().positive().max(1e12),
  type: z.enum(["Income", "Expense"]),
});
export const importTransactionsSchema = z.object({
  rows: z.array(z.unknown()).min(1).max(10_000),
  dryRun: z.boolean().default(false),
});
export type ImportRow = z.infer<typeof importRowSchema>;
export type ImportTransactionsInput = z.infer<typeof importTransactionsSchema>;

const frequency = z.enum(["daily", "weekly", "monthly", "yearly"]);

export const createBudgetSchema = z
  .object({
    categoryId: uuid.optional(), // omitted = overall expense budget
    period: z.enum(["month", "week", "custom"]),
    amountMinor,
    startOn: isoDate.optional(),
    endOn: isoDate.optional(),
    alertThresholdPct: z.number().int().min(1).max(100).default(80),
  })
  .refine((b) => b.period !== "custom" || (b.startOn && b.endOn && b.endOn >= b.startOn), { message: "custom budgets need startOn <= endOn", path: ["endOn"] })
  .refine((b) => !b.startOn || !b.endOn || b.endOn >= b.startOn, { message: "endOn must be on or after startOn", path: ["endOn"] });
export const updateBudgetSchema = z.object({ amountMinor, endOn: isoDate.nullable(), alertThresholdPct: z.number().int().min(1).max(100) }).partial();
export const budgetStatusQuerySchema = z.object({ date: isoDate.optional() });

export const createRecurringSchema = z.object({
  accountId: uuid,
  kind: kindEnum,
  amountMinor,
  categoryId: uuid.optional(),
  note: z.string().max(500).optional(),
  frequency,
  interval: z.number().int().min(1).max(365).default(1),
  startOn: isoDate,
  endOn: isoDate.optional(),
  /** If startOn is in the past: post the missed occurrences (true) or start from the next upcoming one (false). */
  backfill: z.boolean().default(false),
}).refine((r) => !r.endOn || r.endOn >= r.startOn, { message: "endOn must be on or after startOn", path: ["endOn"] });
export const updateRecurringSchema = z
  .object({ amountMinor, categoryId: uuid.nullable(), note: z.string().max(500).nullable(), frequency, interval: z.number().int().min(1).max(365), endOn: isoDate.nullable(), active: z.boolean() })
  .partial();

export type CreateBudgetInput = z.infer<typeof createBudgetSchema>;
export type UpdateBudgetInput = z.infer<typeof updateBudgetSchema>;
export type CreateRecurringInput = z.infer<typeof createRecurringSchema>;
export type UpdateRecurringInput = z.infer<typeof updateRecurringSchema>;
