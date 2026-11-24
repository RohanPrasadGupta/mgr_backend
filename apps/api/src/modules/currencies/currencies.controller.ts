import { Controller, Get, Inject } from "@nestjs/common";
import { asc } from "drizzle-orm";
import { DB, type Db } from "../../db/db";
import { currencies } from "../../db/schema";

@Controller("currencies")
export class CurrenciesController {
  constructor(@Inject(DB) private readonly db: Db) {}
  @Get()
  async list() {
    return { data: await this.db.select().from(currencies).orderBy(asc(currencies.code)) };
  }
}
