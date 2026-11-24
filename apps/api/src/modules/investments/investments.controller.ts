import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  createAssetSchema, createTradeSchema, listTradesSchema, setPriceSchema, sipCalcSchema, sipProjection, updateAssetSchema, updateTradeSchema,
  type CreateAssetInput, type CreateTradeInput, type ListTradesInput, type SetPriceInput, type UpdateAssetInput, type UpdateTradeInput,
} from "@moneymgr/shared";
import { ZodPipe } from "../../common/zod.pipe";
import { UserId } from "../auth/auth.guard";
import { InvestmentsService } from "./investments.service";

const archivedQ = z.object({ archived: z.enum(["true", "false"]).default("false") });

@Controller()
export class InvestmentsController {
  constructor(@Inject(InvestmentsService) private readonly svc: InvestmentsService) {}

  @Get("investments/portfolio") async portfolio(@UserId() u: string) { return { data: await this.svc.portfolio(u) }; }

  @Get("investments/assets") async assets(@UserId() u: string, @Query(new ZodPipe(archivedQ)) q: z.infer<typeof archivedQ>) { return { data: await this.svc.listHoldings(u, q.archived === "true") }; }
  @Post("investments/assets") async createAsset(@UserId() u: string, @Body(new ZodPipe(createAssetSchema)) b: CreateAssetInput) { return { data: await this.svc.createAsset(u, b) }; }
  @Get("investments/assets/:id") async asset(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string) { return { data: await this.svc.getHolding(u, id) }; }
  @Patch("investments/assets/:id") async updateAsset(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(updateAssetSchema)) b: UpdateAssetInput) { return { data: await this.svc.updateAsset(u, id, b) }; }
  @Delete("investments/assets/:id") @HttpCode(204) async removeAsset(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string) { await this.svc.removeAsset(u, id); }

  @Get("investments/assets/:id/prices") async prices(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string) { return { data: await this.svc.listPrices(u, id) }; }
  @Post("investments/assets/:id/prices") async setPrice(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(setPriceSchema)) b: SetPriceInput) { return { data: await this.svc.setPrice(u, id, b) }; }

  @Get("investments/trades") async trades(@UserId() u: string, @Query(new ZodPipe(listTradesSchema)) q: ListTradesInput) { return { data: await this.svc.listTrades(u, q) }; }
  @Post("investments/trades") async createTrade(@UserId() u: string, @Body(new ZodPipe(createTradeSchema)) b: CreateTradeInput) { return { data: await this.svc.createTrade(u, b) }; }
  @Patch("investments/trades/:id") async updateTrade(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(updateTradeSchema)) b: UpdateTradeInput) { return { data: await this.svc.updateTrade(u, id, b) }; }
  @Delete("investments/trades/:id") @HttpCode(204) async removeTrade(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string) { await this.svc.removeTrade(u, id); }

  @Post("calc/sip") @HttpCode(200) sip(@Body(new ZodPipe(sipCalcSchema)) b: z.infer<typeof sipCalcSchema>) { return { data: sipProjection(b.monthly, b.annualRatePct, b.years) }; }
}
