import { Body, Controller, HttpCode, Inject, Post } from "@nestjs/common";
import { importCategoriesSchema, importInvestmentsSchema, importNotesSchema, importTransactionsSchema, type ImportCategoriesInput, type ImportInvestmentsInput, type ImportNotesInput, type ImportTransactionsInput } from "@moneymgr/shared";
import { ZodPipe } from "../../common/zod.pipe";
import { UserId } from "../auth/auth.guard";
import { ImportsService } from "./imports.service";
import { InvestmentImportsService } from "./investment-imports.service";
import { NoteImportsService } from "./note-imports.service";

@Controller("imports")
export class ImportsController {
  constructor(@Inject(ImportsService) private readonly svc: ImportsService, @Inject(InvestmentImportsService) private readonly inv: InvestmentImportsService, @Inject(NoteImportsService) private readonly notes: NoteImportsService) {}

  /** Rows: { date, account, category, note, currency, amount (major units), type: "Income"|"Expense" } — the v1 / Money Manager export shape. */
  @Post("transactions") @HttpCode(200)
  async transactions(@UserId() userId: string, @Body(new ZodPipe(importTransactionsSchema)) body: ImportTransactionsInput) {
    return { data: await this.svc.importTransactions(userId, body.rows, body.dryRun) };
  }

  /** Rows: { name, type: "Income"|"Expense" }. Existing categories (same kind and name, ignoring case and emoji) are skipped. */
  @Post("categories") @HttpCode(200)
  async importCategories(@UserId() userId: string, @Body(new ZodPipe(importCategoriesSchema)) body: ImportCategoriesInput) {
    return { data: await this.svc.importCategories(userId, body.rows, body.dryRun) };
  }

  /** Rows: { title, body (or v1 "content"), date? }. A note with the same title and body as an existing one is skipped. */
  @Post("notes") @HttpCode(200)
  async importNotes(@UserId() userId: string, @Body(new ZodPipe(importNotesSchema)) body: ImportNotesInput) {
    return { data: await this.notes.importNotes(userId, body.rows, body.dryRun) };
  }

  /** v1 stock_analysis_backend documents (mongoexport JSON works as-is): stock-transactions, stock-capital, coin-capital, sip-capital, ssf-capital. */
  @Post("investments") @HttpCode(200)
  async investments(@UserId() userId: string, @Body(new ZodPipe(importInvestmentsSchema)) body: ImportInvestmentsInput) {
    return { data: await this.inv.importV1(userId, body) };
  }
}
