import { Controller, Get, Inject } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DB, type Db } from "../../db/db";
import { Public } from "../auth/auth.guard";

@Public()
@Controller()
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}
  @Get("health") health() { return { status: "ok" }; }
  @Get("ready") async ready() {
    await this.db.execute(sql`select 1`);
    return { status: "ready" };
  }
}
