import { z } from "zod";
import * as R from "./responses";
import {
  byCategoryQuerySchema, dailyQuerySchema, createAccountSchema, createBudgetSchema, createCategorySchema, createRecurringSchema, createTransactionSchema, createTransferSchema, budgetStatusQuerySchema,
  listTransactionsSchema, loginSchema, rangeQuerySchema, refreshSchema, registerSchema, trendQuerySchema, updateAccountSchema, updateBudgetSchema, updateCategorySchema, updateMeSchema,
  updateRecurringSchema, updateTransactionSchema, deleteAccountSchema,
} from "../schemas";
import {
  createAssetSchema, createTradeSchema, importInvestmentsSchema, listTradesSchema, setPriceSchema, sipCalcSchema, updateAssetSchema, updateTradeSchema,
} from "../schemas/investments";
import { importTransactionsSchema } from "../schemas/ledger";
import { changePasswordSchema, forgotPasswordSchema, resetPasswordSchema, verifyEmailSchema } from "../schemas/auth";
import {
  createDebtSchema, createGoalSchema, createNoteSchema, createTagSchema, debtPaymentSchema, goalContributionSchema, listDebtsSchema, listNotesSchema, reportQuerySchema,
  updateDebtSchema, updateGoalSchema, updateNoteSchema, updateTagSchema,
} from "../schemas/planning";
import { currencyCode, isoDate } from "../schemas/common";

export interface RouteDef {
  method: "get" | "post" | "patch" | "delete";
  /** OpenAPI-style path relative to the API root (`/v1`), e.g. `/accounts/{id}`. */
  path: string;
  operationId: string;
  tag: string;
  summary: string;
  public?: boolean;
  query?: z.ZodType;
  body?: z.ZodType;
  /** Success status and body; `null` body = no content. */
  status: 200 | 201 | 202 | 204;
  response: z.ZodType | null;
  /** Request body is multipart/form-data with a single `file` part. */
  multipart?: boolean;
  /** Response is raw bytes (Content-Type of the stored file), not JSON. */
  binary?: boolean;
}

const data = <T extends z.ZodType>(s: T) => R.envelope(s);
const list = <T extends z.ZodType>(s: T) => R.envelope(z.array(s));
const fxQuery = z.object({ from: currencyCode, to: currencyCode, date: isoDate.optional() });
const archivedQuery = z.object({ archived: z.enum(["true", "false"]).optional() });

const r = (method: RouteDef["method"], path: string, operationId: string, tag: string, summary: string, status: RouteDef["status"], response: RouteDef["response"], extra: Partial<RouteDef> = {}): RouteDef =>
  ({ method, path, operationId, tag, summary, status, response, ...extra });

export const routes: RouteDef[] = [
  r("post", "/auth/register", "register", "Auth", "Create an account", 201, data(R.AuthResult), { body: registerSchema, public: true }),
  r("post", "/auth/login", "login", "Auth", "Sign in", 200, data(R.AuthResult), { body: loginSchema, public: true }),
  r("post", "/auth/refresh", "refreshTokens", "Auth", "Rotate the refresh token and get a new access token", 200, data(R.TokenPair), { body: refreshSchema, public: true }),
  r("post", "/auth/logout", "logout", "Auth", "Revoke a refresh token", 204, null, { body: refreshSchema, public: true }),
  r("post", "/auth/forgot-password", "forgotPassword", "Auth", "Email a password-reset link (always 202, so it never reveals whether an email is registered)", 202, data(R.Accepted), { body: forgotPasswordSchema, public: true }),
  r("post", "/auth/reset-password", "resetPassword", "Auth", "Set a new password with a reset token; signs out every session", 204, null, { body: resetPasswordSchema, public: true }),
  r("post", "/auth/verify-email", "verifyEmail", "Auth", "Confirm an email address with the emailed token", 200, data(R.Verified), { body: verifyEmailSchema, public: true }),

  r("get", "/me", "getMe", "Profile", "Current user", 200, data(R.User)),
  r("patch", "/me", "updateMe", "Profile", "Update profile and preferences", 200, data(R.User), { body: updateMeSchema }),
  r("post", "/me/resend-verification", "resendVerification", "Profile", "Send the email-verification link again", 202, data(R.Accepted)),
  r("post", "/me/password", "changePassword", "Profile", "Change the password (signs out other sessions)", 204, null, { body: changePasswordSchema }),
  r("delete", "/me", "deleteMe", "Profile", "Permanently delete the account and all its data (requires the password)", 204, null, { body: deleteAccountSchema }),
  r("get", "/currencies", "listCurrencies", "Profile", "Supported currencies", 200, list(R.Currency)),
  r("get", "/fx", "getFxRate", "FX", "Exchange rate between two currencies on a date", 200, data(R.FxQuote), { query: fxQuery }),

  r("get", "/accounts", "listAccounts", "Accounts", "List accounts with balances", 200, list(R.Account)),
  r("post", "/accounts", "createAccount", "Accounts", "Create an account", 201, data(R.Account), { body: createAccountSchema }),
  r("get", "/accounts/{id}", "getAccount", "Accounts", "Get an account", 200, data(R.Account)),
  r("patch", "/accounts/{id}", "updateAccount", "Accounts", "Update an account", 200, data(R.Account), { body: updateAccountSchema }),
  r("delete", "/accounts/{id}", "deleteAccount", "Accounts", "Delete an account without transactions", 204, null),

  r("get", "/categories", "listCategories", "Categories", "List categories", 200, list(R.Category)),
  r("post", "/categories", "createCategory", "Categories", "Create a category", 201, data(R.Category), { body: createCategorySchema }),
  r("patch", "/categories/{id}", "updateCategory", "Categories", "Update a category", 200, data(R.Category), { body: updateCategorySchema }),
  r("delete", "/categories/{id}", "deleteCategory", "Categories", "Delete a category", 204, null),

  r("get", "/transactions", "listTransactions", "Transactions", "List transactions (cursor pagination)", 200, R.TransactionPage, { query: listTransactionsSchema }),
  r("post", "/transactions", "createTransaction", "Transactions", "Create an income or expense", 201, data(R.Transaction), { body: createTransactionSchema }),
  r("get", "/transactions/{id}", "getTransaction", "Transactions", "Get a transaction", 200, data(R.Transaction)),
  r("patch", "/transactions/{id}", "updateTransaction", "Transactions", "Update a transaction", 200, data(R.Transaction), { body: updateTransactionSchema }),
  r("delete", "/transactions/{id}", "deleteTransaction", "Transactions", "Delete a transaction (both legs of a transfer)", 204, null),
  r("post", "/transfers", "createTransfer", "Transactions", "Move money between two accounts", 201, data(R.TransferResult), { body: createTransferSchema }),

  r("get", "/insights/summary", "getSummary", "Insights", "Income, expense, net and savings rate for a range", 200, data(R.Summary), { query: rangeQuerySchema }),
  r("get", "/insights/by-category", "getByCategory", "Insights", "Totals grouped by category", 200, data(R.ByCategory), { query: byCategoryQuerySchema }),
  r("get", "/insights/daily", "getDaily", "Insights", "Income and expense per day for a range (zero-filled, max 400 days)", 200, data(R.Daily), { query: dailyQuerySchema }),
  r("get", "/insights/trend", "getTrend", "Insights", "Twelve monthly buckets for a year", 200, data(R.Trend), { query: trendQuerySchema }),

  r("get", "/budgets", "listBudgets", "Budgets", "List budgets", 200, list(R.Budget)),
  r("post", "/budgets", "createBudget", "Budgets", "Create a budget", 201, data(R.Budget), { body: createBudgetSchema }),
  r("get", "/budgets/status", "getBudgetStatus", "Budgets", "Spend versus limit for budgets active on a date", 200, data(R.BudgetStatus), { query: budgetStatusQuerySchema }),
  r("patch", "/budgets/{id}", "updateBudget", "Budgets", "Update a budget", 200, data(R.Budget), { body: updateBudgetSchema }),
  r("delete", "/budgets/{id}", "deleteBudget", "Budgets", "Delete a budget", 204, null),

  r("get", "/recurring", "listRecurring", "Recurring", "List recurring rules", 200, list(R.RecurringRule)),
  r("post", "/recurring", "createRecurring", "Recurring", "Create a recurring rule", 201, data(R.RecurringRule), { body: createRecurringSchema }),
  r("post", "/recurring/run-due", "runDueRecurring", "Recurring", "Post any occurrences that are due now", 200, data(R.RunReport)),
  r("get", "/recurring/{id}", "getRecurring", "Recurring", "Get a recurring rule", 200, data(R.RecurringRule)),
  r("patch", "/recurring/{id}", "updateRecurring", "Recurring", "Update, pause or resume a rule", 200, data(R.RecurringRule), { body: updateRecurringSchema }),
  r("delete", "/recurring/{id}", "deleteRecurring", "Recurring", "Delete a rule", 204, null),

  r("post", "/imports/transactions", "importTransactions", "Import", "Import transactions (dry-run supported, idempotent)", 200, data(R.ImportReport), { body: importTransactionsSchema }),
  r("post", "/imports/investments", "importInvestments", "Import", "Import v1 investment documents (dry-run supported, idempotent)", 200, data(R.InvestmentImportReport), { body: importInvestmentsSchema }),

  r("get", "/investments/portfolio", "getPortfolio", "Investments", "Portfolio totals in the base currency", 200, data(R.Portfolio)),
  r("get", "/investments/assets", "listAssets", "Investments", "List assets with their positions", 200, list(R.Holding), { query: archivedQuery }),
  r("post", "/investments/assets", "createAsset", "Investments", "Create an asset", 201, data(R.Asset), { body: createAssetSchema }),
  r("get", "/investments/assets/{id}", "getAsset", "Investments", "Get an asset's position", 200, data(R.Holding)),
  r("patch", "/investments/assets/{id}", "updateAsset", "Investments", "Update an asset", 200, data(R.Asset), { body: updateAssetSchema }),
  r("delete", "/investments/assets/{id}", "deleteAsset", "Investments", "Delete an asset without trades", 204, null),
  r("get", "/investments/assets/{id}/prices", "listAssetPrices", "Investments", "Price history", 200, list(R.PricePoint)),
  r("post", "/investments/assets/{id}/prices", "setAssetPrice", "Investments", "Record a price (or total value for pooled assets)", 201, data(R.PriceSet), { body: setPriceSchema }),
  r("get", "/investments/trades", "listTrades", "Investments", "List trades", 200, list(R.Trade), { query: listTradesSchema }),
  r("post", "/investments/trades", "createTrade", "Investments", "Record a trade, contribution or withdrawal", 201, data(R.Trade), { body: createTradeSchema }),
  r("patch", "/investments/trades/{id}", "updateTrade", "Investments", "Update a trade", 200, data(R.Trade), { body: updateTradeSchema }),
  r("delete", "/investments/trades/{id}", "deleteTrade", "Investments", "Delete a trade", 204, null),
  r("get", "/tags", "listTags", "Tags", "List tags with usage counts", 200, list(R.Tag)),
  r("post", "/tags", "createTag", "Tags", "Create a tag", 201, data(R.Tag), { body: createTagSchema }),
  r("patch", "/tags/{id}", "updateTag", "Tags", "Rename or recolour a tag", 200, data(R.Tag), { body: updateTagSchema }),
  r("delete", "/tags/{id}", "deleteTag", "Tags", "Delete a tag (removes it from its transactions)", 204, null),

  r("get", "/transactions/{id}/attachments", "listAttachments", "Attachments", "Files attached to a transaction", 200, list(R.Attachment)),
  // Upload is multipart/form-data with one `file` part (≤ 10 MB; JPEG, PNG, WebP, HEIC or PDF) — described by hand in buildOpenApi.
  r("post", "/transactions/{id}/attachments", "uploadAttachment", "Attachments", "Attach a receipt (multipart/form-data, field `file`)", 201, data(R.Attachment), { multipart: true }),
  r("get", "/attachments/{id}/file", "downloadAttachment", "Attachments", "Download an attachment's bytes", 200, null, { binary: true }),
  r("delete", "/attachments/{id}", "deleteAttachment", "Attachments", "Delete an attachment", 204, null),

  r("get", "/goals", "listGoals", "Goals", "List goals with progress", 200, list(R.Goal), { query: archivedQuery }),
  r("post", "/goals", "createGoal", "Goals", "Create a savings goal", 201, data(R.Goal), { body: createGoalSchema }),
  r("get", "/goals/{id}", "getGoal", "Goals", "A goal with its contributions", 200, data(R.GoalDetail)),
  r("patch", "/goals/{id}", "updateGoal", "Goals", "Update a goal", 200, data(R.Goal), { body: updateGoalSchema }),
  r("delete", "/goals/{id}", "deleteGoal", "Goals", "Delete a goal and its contributions", 204, null),
  r("post", "/goals/{id}/contributions", "addGoalContribution", "Goals", "Add (or withdraw) money toward a goal", 201, data(R.GoalContribution), { body: goalContributionSchema }),
  r("delete", "/goals/{id}/contributions/{contributionId}", "deleteGoalContribution", "Goals", "Delete a contribution", 204, null),

  r("get", "/debts", "listDebts", "Debts", "List debts (open by default)", 200, list(R.Debt), { query: listDebtsSchema }),
  r("get", "/debts/summary", "getDebtSummary", "Debts", "What you are owed and what you owe, per currency", 200, data(R.DebtSummary)),
  r("post", "/debts", "createDebt", "Debts", "Record money lent or borrowed", 201, data(R.Debt), { body: createDebtSchema }),
  r("get", "/debts/{id}", "getDebt", "Debts", "A debt with its payments", 200, data(R.DebtDetail)),
  r("patch", "/debts/{id}", "updateDebt", "Debts", "Update a debt", 200, data(R.Debt), { body: updateDebtSchema }),
  r("delete", "/debts/{id}", "deleteDebt", "Debts", "Delete a debt and its payments", 204, null),
  r("post", "/debts/{id}/payments", "addDebtPayment", "Debts", "Record a repayment", 201, data(R.DebtPayment), { body: debtPaymentSchema }),
  r("delete", "/debts/{id}/payments/{paymentId}", "deleteDebtPayment", "Debts", "Delete a repayment", 204, null),

  r("get", "/notes", "listNotes", "Notes", "List notes (pinned first), optional search", 200, list(R.Note), { query: listNotesSchema }),
  r("post", "/notes", "createNote", "Notes", "Create a note", 201, data(R.Note), { body: createNoteSchema }),
  r("patch", "/notes/{id}", "updateNote", "Notes", "Update a note", 200, data(R.Note), { body: updateNoteSchema }),
  r("delete", "/notes/{id}", "deleteNote", "Notes", "Delete a note", 204, null),

  r("get", "/reports", "getReport", "Reports", "Monthly or yearly report: totals, comparison with the previous period, categories, accounts, top expenses, budgets", 200, data(R.Report), { query: reportQuerySchema }),

  r("post", "/calc/sip", "calculateSip", "Calculators", "Project a monthly investment (annuity-due)", 200, data(R.SipResult), { body: sipCalcSchema }),
];
