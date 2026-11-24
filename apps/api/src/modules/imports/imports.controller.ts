import { Body, Controller, HttpCode, Inject, Post } from "@nestjs/common";
import { importInvestmentsSchema, importTransactionsSchema, type ImportInvestmentsInput, type ImportTransactionsInput } from "@moneymgr/shared";
import { ZodPipe } from "../../common/zod.pipe";
import { UserId } from "../auth/auth.guard";
import { ImportsService } from "./imports.service";
import { InvestmentImportsService } from "./investment-imports.service";

@Controller("imports")
export class ImportsController {
  constructor(@Inject(ImportsService) private readonly svc: ImportsService, @Inject(InvestmentImportsService) private readonly inv: InvestmentImportsService) {}

  /** Rows: { date, account, category, note, currency, amount (major units), type: "Income"|"Expense" } — the v1 / Money Manager export shape. */
  @Post("transactions") @HttpCode(200)
  async transactions(@UserId() userId: string, @Body(new ZodPipe(importTransactionsSchema)) body: ImportTransactionsInput) {
    return { data: await this.svc.importTransactions(userId, body.rows, body.dryRun) };
  }

  /** v1 stock_analysis_backend documents (mongoexport JSON works as-is): stock-transactions, stock-capital, coin-capital, sip-capital, ssf-capital. */
  @Post("investments") @HttpCode(200)
  async investments(@UserId() userId: string, @Body(new ZodPipe(importInvestmentsSchema)) body: ImportInvestmentsInput) {
    return { data: await this.inv.importV1(userId, body) };
  }
}
