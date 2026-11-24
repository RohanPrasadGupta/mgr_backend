import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { createAccountSchema, updateAccountSchema, type CreateAccountInput, type UpdateAccountInput } from "@moneymgr/shared";
import { ZodPipe } from "../../common/zod.pipe";
import { UserId } from "../auth/auth.guard";
import { AccountsService } from "./accounts.service";

@Controller("accounts")
export class AccountsController {
  constructor(@Inject(AccountsService) private readonly svc: AccountsService) {}
  @Get() async list(@UserId() u: string) { return { data: await this.svc.list(u) }; }
  @Get(":id") async get(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string) { return { data: await this.svc.get(u, id) }; }
  @Post() async create(@UserId() u: string, @Body(new ZodPipe(createAccountSchema)) b: CreateAccountInput) { return { data: await this.svc.create(u, b) }; }
  @Patch(":id") async update(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(updateAccountSchema)) b: UpdateAccountInput) { return { data: await this.svc.update(u, id, b) }; }
  @Delete(":id") @HttpCode(204) async remove(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string) { await this.svc.remove(u, id); }
}
