import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import {
  createTransactionSchema, createTransferSchema, listTransactionsSchema, updateTransactionSchema,
  type CreateTransactionInput, type CreateTransferInput, type ListTransactionsInput, type UpdateTransactionInput,
} from "@moneymgr/shared";
import { ZodPipe } from "../../common/zod.pipe";
import { UserId } from "../auth/auth.guard";
import { TransactionsService } from "./transactions.service";

@Controller()
export class TransactionsController {
  constructor(@Inject(TransactionsService) private readonly svc: TransactionsService) {}
  @Get("transactions") list(@UserId() u: string, @Query(new ZodPipe(listTransactionsSchema)) q: ListTransactionsInput) { return this.svc.list(u, q); }
  @Get("transactions/:id") async get(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string) { return { data: await this.svc.get(u, id) }; }
  @Post("transactions") async create(@UserId() u: string, @Body(new ZodPipe(createTransactionSchema)) b: CreateTransactionInput) { return { data: await this.svc.create(u, b) }; }
  @Patch("transactions/:id") async update(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(updateTransactionSchema)) b: UpdateTransactionInput) { return { data: await this.svc.update(u, id, b) }; }
  @Delete("transactions/:id") @HttpCode(204) async remove(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string) { await this.svc.remove(u, id); }
  @Post("transfers") async transfer(@UserId() u: string, @Body(new ZodPipe(createTransferSchema)) b: CreateTransferInput) { return { data: await this.svc.createTransfer(u, b) }; }
}
