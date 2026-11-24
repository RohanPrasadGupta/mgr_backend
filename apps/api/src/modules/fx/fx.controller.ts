import { Controller, Get, Inject, Query } from "@nestjs/common";
import { z } from "zod";
import { currencyCode, isoDate } from "@moneymgr/shared";
import { ZodPipe } from "../../common/zod.pipe";
import { notFound } from "../../common/errors";
import { FxService } from "./fx.service";

const q = z.object({ from: currencyCode, to: currencyCode, date: isoDate.default(() => new Date().toISOString().slice(0, 10)) });

@Controller("fx")
export class FxController {
  constructor(@Inject(FxService) private readonly fx: FxService) {}
  @Get()
  async rate(@Query(new ZodPipe(q)) p: z.infer<typeof q>) {
    const quote = await this.fx.getRate(p.from, p.to, p.date);
    if (!quote) throw notFound("FX rate");
    return { data: quote };
  }
}
