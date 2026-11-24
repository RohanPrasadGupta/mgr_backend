import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { budgetStatusQuerySchema, createBudgetSchema, updateBudgetSchema, type CreateBudgetInput, type UpdateBudgetInput } from "@moneymgr/shared";
import { ZodPipe } from "../../common/zod.pipe";
import { UserId } from "../auth/auth.guard";
import { BudgetsService } from "./budgets.service";

@Controller("budgets")
export class BudgetsController {
  constructor(@Inject(BudgetsService) private readonly svc: BudgetsService) {}
  @Get() async list(@UserId() u: string) { return { data: await this.svc.list(u) }; }
  @Get("status") async status(@UserId() u: string, @Query(new ZodPipe(budgetStatusQuerySchema)) q: { date?: string }) { return { data: await this.svc.status(u, q.date) }; }
  @Post() async create(@UserId() u: string, @Body(new ZodPipe(createBudgetSchema)) b: CreateBudgetInput) { return { data: await this.svc.create(u, b) }; }
  @Patch(":id") async update(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(updateBudgetSchema)) b: UpdateBudgetInput) { return { data: await this.svc.update(u, id, b) }; }
  @Delete(":id") @HttpCode(204) async remove(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string) { await this.svc.remove(u, id); }
}
