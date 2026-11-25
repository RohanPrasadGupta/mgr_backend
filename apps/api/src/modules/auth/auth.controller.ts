import { Body, Controller, HttpCode, Inject, Post, Headers } from "@nestjs/common";
import { RouteConfig } from "@nestjs/platform-fastify";
import {
  forgotPasswordSchema, loginSchema, refreshSchema, registerSchema, resetPasswordSchema, verifyEmailSchema, type LoginInput, type RegisterInput,
} from "@moneymgr/shared";
import { ZodPipe } from "../../common/zod.pipe";
import { loadConfig } from "../../config";
import { Public } from "./auth.guard";
import { AuthService } from "./auth.service";

/** Stricter per-IP limit than the global one (RATE_LIMIT_PER_MIN) on everything that checks a password or sends mail. */
const strict = () => RouteConfig({ rateLimit: { max: loadConfig().AUTH_RATE_LIMIT_PER_MIN, timeWindow: "1 minute" } });

@Public()
@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post("register") @strict()
  async register(@Body(new ZodPipe(registerSchema)) body: RegisterInput, @Headers("user-agent") ua?: string) {
    return { data: await this.auth.register(body, ua) };
  }
  @Post("login") @HttpCode(200) @strict()
  async login(@Body(new ZodPipe(loginSchema)) body: LoginInput, @Headers("user-agent") ua?: string) {
    return { data: await this.auth.login(body, ua) };
  }
  @Post("refresh") @HttpCode(200)
  async refresh(@Body(new ZodPipe(refreshSchema)) body: { refreshToken: string }, @Headers("user-agent") ua?: string) {
    return { data: await this.auth.refresh(body.refreshToken, ua) };
  }
  @Post("logout") @HttpCode(204)
  async logout(@Body(new ZodPipe(refreshSchema)) body: { refreshToken: string }) {
    await this.auth.logout(body.refreshToken);
  }
  @Post("forgot-password") @HttpCode(202) @strict()
  async forgot(@Body(new ZodPipe(forgotPasswordSchema)) body: { email: string }) {
    await this.auth.forgotPassword(body.email);
    return { data: { accepted: true as const } };
  }
  @Post("reset-password") @HttpCode(204) @strict()
  async reset(@Body(new ZodPipe(resetPasswordSchema)) body: { token: string; password: string }) {
    await this.auth.resetPassword(body.token, body.password);
  }
  @Post("verify-email") @HttpCode(200) @strict()
  async verify(@Body(new ZodPipe(verifyEmailSchema)) body: { token: string }) {
    await this.auth.verifyEmail(body.token);
    return { data: { verified: true as const } };
  }
}
