import { Body, Controller, Get, Inject, Patch } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { updateMeSchema, type UpdateMeInput } from "@moneymgr/shared";
import { DB, type Db } from "../../db/db";
import { currencies, users } from "../../db/schema";
import { notFound, unprocessable } from "../../common/errors";
import { ZodPipe } from "../../common/zod.pipe";
import { UserId } from "../auth/auth.guard";

const pub = (u: typeof users.$inferSelect) => ({ id: u.id, email: u.email, name: u.name, baseCurrency: u.baseCurrency, timezone: u.timezone, locale: u.locale, weekStart: u.weekStart });

@Controller("me")
export class UsersController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async me(@UserId() userId: string) {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!u) throw notFound("User");
    return { data: pub(u) };
  }

  @Patch()
  async update(@UserId() userId: string, @Body(new ZodPipe(updateMeSchema)) body: UpdateMeInput) {
    if (body.baseCurrency) {
      const [c] = await this.db.select().from(currencies).where(eq(currencies.code, body.baseCurrency));
      if (!c) throw unprocessable("unsupported_currency", `Currency ${body.baseCurrency} is not supported`);
    }
    const [u] = await this.db.update(users).set(body).where(eq(users.id, userId)).returning();
    if (!u) throw notFound("User");
    return { data: pub(u) };
  }
}
