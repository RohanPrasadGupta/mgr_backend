import { Body, Controller, Delete, Get, HttpCode, Inject, Patch, Post } from "@nestjs/common";
import { RouteConfig } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { changePasswordSchema, deleteAccountSchema, updateMeSchema, type UpdateMeInput } from "@moneymgr/shared";
import { DB, type Db } from "../../db/db";
import { currencies, users } from "../../db/schema";
import { notFound, unprocessable } from "../../common/errors";
import { ZodPipe } from "../../common/zod.pipe";
import { loadConfig } from "../../config";
import { UserId } from "../auth/auth.guard";
import { AuthService, publicUser } from "../auth/auth.service";
import { AccountDeletionService } from "./account-deletion.service";

const strict = () => RouteConfig({ rateLimit: { max: loadConfig().AUTH_RATE_LIMIT_PER_MIN, timeWindow: "1 minute" } });

@Controller("me")
export class UsersController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AccountDeletionService) private readonly deletion: AccountDeletionService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Get()
  async me(@UserId() userId: string) {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!u) throw notFound("User");
    return { data: publicUser(u) };
  }

  @Patch()
  async update(@UserId() userId: string, @Body(new ZodPipe(updateMeSchema)) body: UpdateMeInput) {
    if (body.baseCurrency) {
      const [c] = await this.db.select().from(currencies).where(eq(currencies.code, body.baseCurrency));
      if (!c) throw unprocessable("unsupported_currency", `Currency ${body.baseCurrency} is not supported`);
    }
    const [u] = await this.db.update(users).set(body).where(eq(users.id, userId)).returning();
    if (!u) throw notFound("User");
    return { data: publicUser(u) };
  }

  @Post("resend-verification") @HttpCode(202) @strict()
  async resend(@UserId() userId: string) {
    await this.auth.resendVerification(userId);
    return { data: { accepted: true as const } };
  }

  @Post("password") @HttpCode(204) @strict()
  async changePassword(@UserId() userId: string, @Body(new ZodPipe(changePasswordSchema)) b: { currentPassword: string; newPassword: string }) {
    await this.auth.changePassword(userId, b.currentPassword, b.newPassword);
  }

  /** Permanently erases the account and every row it owns. Requires the current password. */
  @Delete() @HttpCode(204) @strict()
  async remove(@UserId() userId: string, @Body(new ZodPipe(deleteAccountSchema)) body: { password: string }) {
    await this.deletion.deleteAccount(userId, body.password);
  }
}
