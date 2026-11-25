import { Controller, Get, Inject, Query } from "@nestjs/common";
import { byCategoryQuerySchema, dailyQuerySchema, rangeQuerySchema, trendQuerySchema } from "@moneymgr/shared";
import type { z } from "zod";
import { ZodPipe } from "../../common/zod.pipe";
import { UserId } from "../auth/auth.guard";
import { InsightsService } from "./insights.service";

@Controller("insights")
export class InsightsController {
  constructor(@Inject(InsightsService) private readonly svc: InsightsService) {}
  @Get("summary") async summary(@UserId() u: string, @Query(new ZodPipe(rangeQuerySchema)) q: z.infer<typeof rangeQuerySchema>) { return { data: await this.svc.summary(u, q.from, q.to) }; }
  @Get("by-category") async byCategory(@UserId() u: string, @Query(new ZodPipe(byCategoryQuerySchema)) q: z.infer<typeof byCategoryQuerySchema>) { return { data: await this.svc.byCategory(u, q.from, q.to, q.kind) }; }
  @Get("daily") async daily(@UserId() u: string, @Query(new ZodPipe(dailyQuerySchema)) q: z.infer<typeof dailyQuerySchema>) { return { data: await this.svc.daily(u, q.from, q.to) }; }
  @Get("trend") async trend(@UserId() u: string, @Query(new ZodPipe(trendQuerySchema)) q: z.infer<typeof trendQuerySchema>) { return { data: await this.svc.trend(u, q.year) }; }
}
