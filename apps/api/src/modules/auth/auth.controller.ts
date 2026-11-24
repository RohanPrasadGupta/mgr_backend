import { Body, Controller, HttpCode, Inject, Post, Headers } from "@nestjs/common";
import { loginSchema, refreshSchema, registerSchema, type LoginInput, type RegisterInput } from "@moneymgr/shared";
import { ZodPipe } from "../../common/zod.pipe";
import { Public } from "./auth.guard";
import { AuthService } from "./auth.service";

@Public()
@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post("register")
  async register(@Body(new ZodPipe(registerSchema)) body: RegisterInput, @Headers("user-agent") ua?: string) {
    return { data: await this.auth.register(body, ua) };
  }
  @Post("login") @HttpCode(200)
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
}
