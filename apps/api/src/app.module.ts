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
import { InsightsController } from "./modules/insights/insights.controller";
import { InsightsService } from "./modules/insights/insights.service";
import { TransactionsController } from "./modules/transactions/transactions.controller";
import { TransactionsService } from "./modules/transactions/transactions.service";
import { AccountDeletionService } from "./modules/users/account-deletion.service";
import { UsersController } from "./modules/users/users.controller";

@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: (): Config => loadConfig() },
    { provide: POOL, inject: [CONFIG], useFactory: (c: Config) => createDb(c.DATABASE_URL).pool },
    { provide: DB, inject: [POOL], useFactory: (pool: Pool) => createDb.fromPool(pool) },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    AuthService, AccountsService, CategoriesService, TransactionsService, InsightsService, FxService, ImportsService, BudgetsService, RecurringService, InvestmentsService, InvestmentImportsService, AccountDeletionService,
  ],
  controllers: [HealthController, OpenApiController, AuthController, UsersController, CurrenciesController, AccountsController, CategoriesController, TransactionsController, InsightsController, FxController, ImportsController, BudgetsController, RecurringController, InvestmentsController],
  exports: [CONFIG, DB, POOL],
})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(POOL) private readonly pool: Pool) {}
  async onApplicationShutdown() { await this.pool.end(); }
}
