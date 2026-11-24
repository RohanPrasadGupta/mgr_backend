import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { createRecurringSchema, updateRecurringSchema, type CreateRecurringInput, type UpdateRecurringInput } from "@moneymgr/shared";
import { ZodPipe } from "../../common/zod.pipe";
import { UserId } from "../auth/auth.guard";
import { RecurringService } from "./recurring.service";

@Controller("recurring")
export class RecurringController {
  constructor(@Inject(RecurringService) private readonly svc: RecurringService) {}
  @Get() async list(@UserId() u: string) { return { data: await this.svc.list(u) }; }
  /** Post anything due for the caller now (the scheduler also does this every 15 minutes). */
  @Post("run-due") @HttpCode(200) async runDue(@UserId() u: string) { return { data: await this.svc.runDue({ userId: u }) }; }
  @Get(":id") async get(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string) { return { data: await this.svc.get(u, id) }; }
  @Post() async create(@UserId() u: string, @Body(new ZodPipe(createRecurringSchema)) b: CreateRecurringInput) { return { data: await this.svc.create(u, b) }; }
  @Patch(":id") async update(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(updateRecurringSchema)) b: UpdateRecurringInput) { return { data: await this.svc.update(u, id, b) }; }
  @Delete(":id") @HttpCode(204) async remove(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string) { await this.svc.remove(u, id); }
}
