import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { RouteConfig } from "@nestjs/platform-fastify";
import {
  adminAuditQuerySchema, adminChangePasswordSchema, adminCreateSchema, adminDeleteUserSchema, adminLoginSchema, adminMfaSchema, adminReasonSchema, adminRefreshSchema,
  adminRoleSchema, adminUsersQuerySchema,
  type AdminAuditQuery, type AdminChangePasswordInput, type AdminCreateInput, type AdminLoginInput, type AdminMfaInput, type AdminRoleInput, type AdminUsersQuery,
} from "@moneymgr/shared";
import { ZodPipe } from "../../common/zod.pipe";
import { loadConfig } from "../../config";
import { Public } from "../auth/auth.guard";
import { Admin, AdminGuard, AllowPendingPassword, OwnerOnly, type AdminActor } from "./admin.guard";
import { AdminAccountsService } from "./admin-accounts.service";
import { AdminAuthService } from "./admin-auth.service";
import { AdminService } from "./admin.service";
import { AuditService } from "./audit.service";

type Actor = AdminActor;
// sign-in endpoints get the same strict per-IP limit as customer auth
const strict = () => RouteConfig({ rateLimit: { max: loadConfig().AUTH_RATE_LIMIT_PER_MIN, timeWindow: "1 minute" } });

@Public() // not a customer route: the admin guard (own token key + audience) protects everything below except sign-in
@Controller("admin")
export class AdminAuthController {
  constructor(@Inject(AdminAuthService) private readonly auth: AdminAuthService) {}
  @Post("auth/login") @HttpCode(200) @strict() async login(@Body(new ZodPipe(adminLoginSchema)) b: AdminLoginInput, @Req() req: FastifyRequest) { return { data: await this.auth.login(b, req.ip ?? null) }; }
  @Post("auth/mfa") @HttpCode(200) @strict() async mfa(@Body(new ZodPipe(adminMfaSchema)) b: AdminMfaInput, @Req() req: FastifyRequest) { return { data: await this.auth.mfa(b, req.ip ?? null, req.headers["user-agent"]) }; }
  @Post("auth/refresh") @HttpCode(200) @strict() async refresh(@Body(new ZodPipe(adminRefreshSchema)) b: { refreshToken: string }, @Req() req: FastifyRequest) { return { data: await this.auth.refresh(b.refreshToken, req.ip ?? null, req.headers["user-agent"]) }; }
  @Post("auth/logout") @HttpCode(204) async logout(@Body(new ZodPipe(adminRefreshSchema)) b: { refreshToken: string }) { await this.auth.logout(b.refreshToken); }
}

@Public()
@UseGuards(AdminGuard)
@Controller("admin")
export class AdminController {
  constructor(
    @Inject(AdminAuthService) private readonly auth: AdminAuthService,
    @Inject(AdminService) private readonly svc: AdminService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AdminAccountsService) private readonly accounts: AdminAccountsService,
  ) {}
  @Get("me") @AllowPendingPassword() async me(@Admin() a: Actor) { return { data: await this.auth.me(a.adminId) }; }
  @Post("me/password") @HttpCode(204) @AllowPendingPassword() async changePassword(@Admin() a: Actor, @Body(new ZodPipe(adminChangePasswordSchema)) b: AdminChangePasswordInput) { await this.accounts.changeOwnPassword(a, b.currentPassword, b.newPassword); }

  // ── admin accounts (owners only) ──
  @Get("admins") @OwnerOnly() async admins() { return { data: await this.accounts.list() }; }
  @Post("admins") @HttpCode(201) @OwnerOnly() async createAdmin(@Admin() a: Actor, @Body(new ZodPipe(adminCreateSchema)) b: AdminCreateInput) { return { data: await this.accounts.create(a, b) }; }
  @Post("admins/:id/disable") @HttpCode(200) @OwnerOnly() async disableAdmin(@Admin() a: Actor, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(adminReasonSchema)) b: { reason: string }) { return { data: await this.accounts.disable(a, id, b.reason) }; }
  @Post("admins/:id/enable") @HttpCode(200) @OwnerOnly() async enableAdmin(@Admin() a: Actor, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(adminReasonSchema)) b: { reason: string }) { return { data: await this.accounts.enable(a, id, b.reason) }; }
  @Post("admins/:id/reset-2fa") @HttpCode(200) @OwnerOnly() async resetAdmin2fa(@Admin() a: Actor, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(adminReasonSchema)) b: { reason: string }) { return { data: await this.accounts.resetTwoFactor(a, id, b.reason) }; }
  @Post("admins/:id/reset-password") @HttpCode(200) @OwnerOnly() async resetAdminPassword(@Admin() a: Actor, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(adminReasonSchema)) b: { reason: string }) { return { data: await this.accounts.resetPassword(a, id, b.reason) }; }
  @Post("admins/:id/role") @HttpCode(200) @OwnerOnly() async setAdminRole(@Admin() a: Actor, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(adminRoleSchema)) b: AdminRoleInput) { return { data: await this.accounts.setRole(a, id, b.role, b.reason) }; }
  @Get("stats") async stats() { return { data: await this.svc.stats() }; }
  @Get("users") async users(@Query(new ZodPipe(adminUsersQuerySchema)) q: AdminUsersQuery) { return { data: await this.svc.listUsers(q) }; }
  @Get("users/:id") async user(@Admin() a: Actor, @Param("id", ParseUUIDPipe) id: string) { return { data: await this.svc.getUser(a, id) }; }
  @Post("users/:id/suspend") @HttpCode(200) async suspend(@Admin() a: Actor, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(adminReasonSchema)) b: { reason: string }) { return { data: await this.svc.suspend(a, id, b.reason) }; }
  @Post("users/:id/reactivate") @HttpCode(200) async reactivate(@Admin() a: Actor, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(adminReasonSchema)) b: { reason: string }) { return { data: await this.svc.reactivate(a, id, b.reason) }; }
  @Post("users/:id/sign-out") @HttpCode(200) async signOut(@Admin() a: Actor, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(adminReasonSchema)) b: { reason: string }) { return { data: await this.svc.signOut(a, id, b.reason) }; }
  @Post("users/:id/resend-verification") @HttpCode(202) async resend(@Admin() a: Actor, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(adminReasonSchema)) b: { reason: string }) { return { data: await this.svc.resendVerification(a, id, b.reason) }; }
  @Post("users/:id/mark-verified") @HttpCode(200) async markVerified(@Admin() a: Actor, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(adminReasonSchema)) b: { reason: string }) { return { data: await this.svc.markVerified(a, id, b.reason) }; }
  @Delete("users/:id") @HttpCode(204) async remove(@Admin() a: Actor, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(adminDeleteUserSchema)) b: { reason: string; confirmEmail: string }) { await this.svc.deleteUser(a, id, b.reason, b.confirmEmail); }
  @Post("users/:id/support") @HttpCode(201) async openSupport(@Admin() a: Actor, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(adminReasonSchema)) b: { reason: string }) { return { data: await this.svc.openSupport(a, id, b.reason) }; }
  @Delete("users/:id/support") @HttpCode(204) async closeSupport(@Admin() a: Actor, @Param("id", ParseUUIDPipe) id: string) { await this.svc.closeSupport(a, id); }
  @Get("users/:id/data/:kind") async data(@Admin() a: Actor, @Param("id", ParseUUIDPipe) id: string, @Param("kind") kind: string) { return { data: await this.svc.supportData(a, id, kind) }; }
  @Get("audit") async auditLog(@Query(new ZodPipe(adminAuditQuerySchema)) q: AdminAuditQuery) { return { data: await this.audit.list(q) }; }
  @Get("health") async health() { return { data: await this.svc.health() }; }
}
