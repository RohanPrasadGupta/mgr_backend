import { Global, Module, type OnApplicationShutdown, Inject } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import type { Pool } from "pg";
import { AllExceptionsFilter } from "./common/exception.filter";
import { loadConfig, type Config } from "./config";
import { CONFIG, DB, POOL, createDb } from "./db/db";
import { AccountsController } from "./modules/accounts/accounts.controller";
import { AccountsService } from "./modules/accounts/accounts.service";
import { AuthController } from "./modules/auth/auth.controller";
import { AuthGuard } from "./modules/auth/auth.guard";
import { AuthService } from "./modules/auth/auth.service";
import { BudgetsController } from "./modules/budgets/budgets.controller";
import { BudgetsService } from "./modules/budgets/budgets.service";
import { RecurringController } from "./modules/recurring/recurring.controller";
import { RecurringService } from "./modules/recurring/recurring.service";
import { InvestmentsController } from "./modules/investments/investments.controller";
import { InvestmentsService } from "./modules/investments/investments.service";
import { CategoriesController } from "./modules/categories/categories.controller";
import { CategoriesService } from "./modules/categories/categories.service";
import { CurrenciesController } from "./modules/currencies/currencies.controller";
import { FxController } from "./modules/fx/fx.controller";
import { FxService } from "./modules/fx/fx.service";
import { OpenApiController } from "./modules/openapi/openapi.controller";
import { HealthController } from "./modules/health/health.controller";
import { ImportsController } from "./modules/imports/imports.controller";
import { InvestmentImportsService } from "./modules/imports/investment-imports.service";
import { ImportsService } from "./modules/imports/imports.service";
import { NoteImportsService } from "./modules/imports/note-imports.service";
import { InsightsController } from "./modules/insights/insights.controller";
import { InsightsService } from "./modules/insights/insights.service";
import { TransactionsController } from "./modules/transactions/transactions.controller";
import { TransactionsService } from "./modules/transactions/transactions.service";
import { AccountDeletionService } from "./modules/users/account-deletion.service";
import { UsersController } from "./modules/users/users.controller";
import { AttachmentsController, AttachmentsService } from "./modules/attachments/attachments";
import { DebtsController, DebtsService } from "./modules/debts/debts";
import { GoalsController, GoalsService } from "./modules/goals/goals";
import { NotesController, NotesService } from "./modules/notes/notes";
import { ReportsController, ReportsService } from "./modules/reports/reports";
import { TagsController, TagsService } from "./modules/tags/tags";
import { KEYS, KV, MemoryKv, REDIS, RedisKv, createRedis, keys } from "./infra/kv";
import { MAILER, Mailer } from "./infra/mailer";
import { DiskStorage, STORAGE } from "./infra/storage";
import type Redis from "ioredis";
import { AdminAuthController, AdminController } from "./modules/admin/admin.controller";
import { AdminAuthService } from "./modules/admin/admin-auth.service";
import { AdminGuard } from "./modules/admin/admin.guard";
import { AdminService } from "./modules/admin/admin.service";
import { AuditService } from "./modules/admin/audit.service";

@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: (): Config => loadConfig() },
    { provide: POOL, inject: [CONFIG], useFactory: (c: Config) => createDb(c.DATABASE_URL).pool },
    { provide: DB, inject: [POOL], useFactory: (pool: Pool) => createDb.fromPool(pool) },
    { provide: REDIS, inject: [CONFIG], useFactory: (c: Config): Redis | null => (c.REDIS_URL ? createRedis(c.REDIS_URL) : null) },
    { provide: KV, inject: [REDIS], useFactory: (r: Redis | null) => (r ? new RedisKv(r) : new MemoryKv()) },
    { provide: KEYS, inject: [CONFIG], useFactory: (c: Config) => keys(c.REDIS_PREFIX) },
    { provide: MAILER, inject: [CONFIG], useFactory: (c: Config) => new Mailer(c) },
    { provide: STORAGE, inject: [CONFIG], useFactory: (c: Config) => new DiskStorage(c.UPLOAD_DIR) },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    AuthService, AccountsService, CategoriesService, TransactionsService, InsightsService, FxService, ImportsService, BudgetsService, RecurringService, InvestmentsService, InvestmentImportsService, NoteImportsService, AccountDeletionService,
    TagsService, AttachmentsService, GoalsService, DebtsService, NotesService, ReportsService,
    AuditService, AdminAuthService, AdminService, AdminGuard,
  ],
  controllers: [HealthController, OpenApiController, AuthController, UsersController, CurrenciesController, AccountsController, CategoriesController, TransactionsController, InsightsController, FxController, ImportsController, BudgetsController, RecurringController, InvestmentsController,
    TagsController, AttachmentsController, GoalsController, DebtsController, NotesController, ReportsController,
    AdminAuthController, AdminController],
  exports: [CONFIG, DB, POOL, REDIS, KV, KEYS, MAILER, STORAGE],
})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(POOL) private readonly pool: Pool, @Inject(REDIS) private readonly redis: Redis | null) {}
  async onApplicationShutdown() { await this.pool.end(); await this.redis?.quit().catch(() => {}); }
}
