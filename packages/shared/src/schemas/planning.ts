import { z } from "zod";
import { amountMinor, currencyCode, isoDate, uuid } from "./common";

const name = z.string().trim().min(1).max(60);
const note = z.string().max(1000);
const color = z.string().max(20);

// ── tags ──
export const createTagSchema = z.object({ name: z.string().trim().min(1).max(40), color: color.optional() });
export const updateTagSchema = z.object({ name: z.string().trim().min(1).max(40), color: color.nullable() }).partial();

// ── goals ──
export const createGoalSchema = z.object({
  name,
  targetMinor: amountMinor,
  /** Defaults to the user's base currency; must match the linked account's currency when one is linked. */
  currency: currencyCode.optional(),
  targetDate: isoDate.optional(),
  accountId: uuid.optional(),
  icon: z.string().max(40).optional(),
  color: color.optional(),
  note: note.optional(),
});
export const updateGoalSchema = z.object({
  name, targetMinor: amountMinor, targetDate: isoDate.nullable(), accountId: uuid.nullable(), icon: z.string().max(40).nullable(), color: color.nullable(), note: note.nullable(), archived: z.boolean(),
}).partial();
export const goalContributionSchema = z.object({
  /** Positive saves toward the goal, negative withdraws. */
  amountMinor: z.number().int().refine((n) => n !== 0 && Math.abs(n) <= Number.MAX_SAFE_INTEGER, "must be a non-zero amount"),
  occurredOn: isoDate.optional(),
  note: z.string().max(300).optional(),
});

// ── debts ──
export const debtDirections = ["lent", "borrowed"] as const;
export const createDebtSchema = z.object({
  direction: z.enum(debtDirections),
  counterparty: name,
  principalMinor: amountMinor,
  currency: currencyCode.optional(),
  startedOn: isoDate.optional(),
  dueOn: isoDate.optional(),
  note: note.optional(),
}).refine((d) => !d.startedOn || !d.dueOn || d.dueOn >= d.startedOn, { message: "dueOn must be on or after startedOn", path: ["dueOn"] });
export const updateDebtSchema = z.object({ counterparty: name, principalMinor: amountMinor, dueOn: isoDate.nullable(), note: note.nullable() }).partial();
export const debtPaymentSchema = z.object({ amountMinor, paidOn: isoDate.optional(), note: z.string().max(300).optional() });
export const listDebtsSchema = z.object({ status: z.enum(["open", "settled", "all"]).default("open") });

// ── notes ──
export const createNoteSchema = z.object({ title: z.string().trim().min(1).max(120), body: z.string().max(20_000).default(""), pinned: z.boolean().default(false) });
export const updateNoteSchema = z.object({ title: z.string().trim().min(1).max(120), body: z.string().max(20_000), pinned: z.boolean() }).partial();
export const listNotesSchema = z.object({ q: z.string().trim().min(1).max(100).optional() });
/** One note from another app. `date` (any ISO date/time) becomes its created/updated time; `content` is accepted as `body`. */
export const importNoteRowSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().max(20_000).default(""),
  date: z.string().max(40).optional(),
});
export const importNotesSchema = z.object({ rows: z.array(z.unknown()).min(1).max(10_000), dryRun: z.boolean().default(false) });

// ── reports ──
export const reportQuerySchema = z.object({
  /** "all" = everything from the first transaction up to today. */
  period: z.enum(["month", "year", "all"]),
  year: z.coerce.number().int().min(1970).max(2200).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
})
  .refine((q) => q.period === "all" || q.year !== undefined, { message: "year is required", path: ["year"] })
  .refine((q) => q.period !== "month" || q.month !== undefined, { message: "month is required for a monthly report", path: ["month"] });

export type CreateTagInput = z.infer<typeof createTagSchema>;
export type UpdateTagInput = z.infer<typeof updateTagSchema>;
export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;
export type GoalContributionInput = z.infer<typeof goalContributionSchema>;
export type CreateDebtInput = z.infer<typeof createDebtSchema>;
export type UpdateDebtInput = z.infer<typeof updateDebtSchema>;
export type DebtPaymentInput = z.infer<typeof debtPaymentSchema>;
export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;
export type ImportNotesInput = z.infer<typeof importNotesSchema>;
export type ReportQuery = z.infer<typeof reportQuerySchema>;
