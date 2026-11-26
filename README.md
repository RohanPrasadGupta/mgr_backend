# mgr_backend — MoneyMgr v2 API

NestJS (Fastify) + Drizzle + PostgreSQL. See `PLAN.md` (roadmap) and `BACKEND_ANALYSIS.md` (v1 analysis).

```bash
pnpm install
pnpm db:up                      # Postgres via docker compose (infra/docker-compose.yml)
cp apps/api/.env.example apps/api/.env
pnpm db:migrate                 # applies drizzle/ migrations + seeds currencies
pnpm dev                        # http://localhost:8000  (health: /health, /ready)
pnpm test                       # shared unit tests + API integration tests (creates moneymgr_test DB)
pnpm db:generate                # after editing apps/api/src/db/schema.ts
```

Layout: `apps/api` (Nest app, `src/modules/*`, `drizzle/` migrations, `test/`), `packages/shared` (Zod schemas, money/date/SIP helpers shared with web + mobile).

## API (all under `/v1`, JSON envelope `{ data, meta? }` / `{ error:{code,message,details?} }`)
| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register`, `/auth/login`, `/auth/refresh` (rotating, reuse-detected), `/auth/logout` |
| Me | `GET/PATCH /me` |
| Currencies | `GET /currencies` |
| Accounts | `GET/POST /accounts`, `GET/PATCH/DELETE /accounts/:id` (balance computed in SQL) |
| Categories | `GET/POST /categories`, `PATCH/DELETE /categories/:id` |
| Transactions | `GET /transactions` (cursor + filters `from,to,accountId,categoryId,kind,q,minMinor,maxMinor`), `POST`, `GET/PATCH/DELETE /transactions/:id` |
| Transfers | `POST /transfers` (cross-currency needs `toAmountMinor`) |
| FX | `GET /fx?from&to&date` (stored daily rates; `pnpm --filter @moneymgr/api fx:refresh` to pull now, auto-refresh every 12h) |
| Import | `POST /imports/transactions` `{rows, dryRun}` — rows `{date, account, category, note, currency, amount, type: Income\|Expense}`; emoji prefixes become category icons; re-import is idempotent |
| Import categories | `POST /imports/categories` `{rows, dryRun}` — rows `{name, type: Income\|Expense}`; a leading emoji becomes the icon; existing ones are skipped (and get the emoji if they had no icon) |
| Import notes | `POST /imports/notes` `{rows, dryRun}` — rows `{title, body, date?}` (v1 "content" is accepted as body); a note with the same title and body as an existing one is skipped |
| Budgets | `GET/POST /budgets`, `PATCH/DELETE /budgets/:id`, `GET /budgets/status?date=` (spent, remaining, pct, `ok\|warning\|over`) |
| Recurring | `GET/POST /recurring`, `GET/PATCH/DELETE /recurring/:id`, `POST /recurring/run-due` — posts due occurrences; also runs automatically every 15 min |
| Investments | `GET/POST /investments/assets`, `GET/PATCH/DELETE /investments/assets/:id` (holding: qty, avg cost, P/L, XIRR), `GET/POST /investments/assets/:id/prices`, `GET/POST /investments/trades`, `PATCH/DELETE /investments/trades/:id`, `GET /investments/portfolio`, `POST /calc/sip`, `POST /imports/investments` (v1 Mongo docs) |
| Insights | `GET /insights/summary`, `/insights/by-category`, `/insights/trend?year=` |
| Admin | `GET /admin/me`, `POST /admin/me/password`; owners: `GET/POST /admin/admins`, `POST /admin/admins/:id/{disable,enable,reset-2fa,reset-password,role}`; `POST /admin/auth/{login,mfa,refresh,logout}` (password → TOTP 2FA), `GET /admin/{me,stats,health,audit}`, `GET /admin/users`, `GET /admin/users/:id`, `POST /admin/users/:id/{suspend,reactivate,sign-out,resend-verification,mark-verified}` (reason required), `DELETE /admin/users/:id` (reason + `confirmEmail`), `POST/DELETE /admin/users/:id/support` + `GET /admin/users/:id/data/:kind` (time-limited, audited support view). Used by `../mgr_admin`. |

Conventions: money = integer minor units + currency; each transaction stores `fxRate` + `baseAmountMinor`; `occurredOn` is the calendar date in the user's timezone; every query is scoped by `userId`.

## Hosting
Budget AWS setup (one ARM server in Singapore, Docker, automatic HTTPS, nightly S3 backups, ~$25/month): see [infra/aws/README.md](infra/aws/README.md).
The API image is `apps/api/Dockerfile` (build context = repo root); it applies migrations on every start.

## Request logs
The API prints one line per request to stdout (Render / Docker logs):
```
2026-11-26T07:12:51.616Z WARN  POST /v1/auth/login 401 18ms ip=203.0.113.7 rid=d67bdbf1-…
2026-11-26T07:12:52.004Z INFO  GET /v1/transactions 200 9ms ip=203.0.113.7 user=0f3c…-… rid=4a1e…
```
Level follows the status (5xx `ERROR`, 4xx `WARN`). Query strings, headers and bodies are never logged; successful `/health`
and `/ready` probes are skipped. Every response carries `X-Request-Id` (a caller may send its own, 8–64 safe characters),
and an unexpected error's stack trace starts with the same `rid=`, so a user's report leads straight to the failing request.
`LOG_FORMAT=json` for log tools; `LOG_REQUESTS=false` to turn it off.

## Currencies
153 currencies (all with daily FX rates) are seeded into `currencies` on every start; decimal places follow ISO 4217
(`minorUnit` in `packages/shared/src/money.ts` — the web, phone and admin apps' `lib/money.ts` must match). Each user
has their own list in `users.currencies` (`GET/PATCH /me` → `currencies`): the base currency is always in it, and
creating an account, asset or debt — or importing — in another currency adds that currency automatically. The apps
show your currencies first in every picker and the rest under "Other currencies"; the list is edited in Settings.

## Admin accounts
Admins are separate from users and are managed from the command line (each command is written to the audit log):
```bash
pnpm --filter @moneymgr/api admin create --email you@example.com --name "Your Name"   # password prompt (min 12) or ADMIN_PASSWORD
pnpm --filter @moneymgr/api admin list
pnpm --filter @moneymgr/api admin reset-2fa --email you@example.com                   # lost authenticator
pnpm --filter @moneymgr/api admin disable --email you@example.com                     # or enable
```
Set `ADMIN_SECRET` (≥32 chars, different from `JWT_SECRET`; required in production). The dashboard is `../mgr_admin`.

Admins created from the command line are **owners** (`--role admin` for a regular one). After that, owners manage
admins on the site's **Admins** page: add (the API returns a 16-character one-time password, shown once; the new
admin must replace it at first sign-in before anything else works), disable/enable, reset password, reset
authenticator, make owner/regular. Every change needs a reason and is audited; nobody can act on their own account
there, and at least one active owner always remains. Regular admins keep the support tools but don't see the page.

## Import your v1 spreadsheet
```bash
pnpm --filter @moneymgr/api import:v1 -- --file "/path/Money Manager_8-26-25.xls" --email you@example.com --dry-run
pnpm --filter @moneymgr/api import:v1 -- --file "/path/Money Manager_8-26-25.xls" --email you@example.com
```
Register the user first (via `/v1/auth/register`). Non-base-currency rows need a stored FX rate, otherwise they are reported as invalid, never silently dropped.

## Moving from the old app (Excel backup)
In the old MoneyMgr: **Export Data → Download Excel backup** (one `.xlsx` with every transaction, category, currency, note,
stock trade and investment record). In the new web app: **Import → Restore from old app**, choose the file, **Check**, then
**Import everything**. It calls `POST /imports/categories` (first, so categories keep their emoji), `/imports/transactions`, `/imports/notes`
and `/imports/investments` (one per sheet, ≤10,000 rows per request); all are idempotent, so re-importing the same file adds nothing. Currencies aren't imported — the new app
knows them all — but the screen warns about any code it doesn't support.

## API contract (OpenAPI)
`GET /openapi.json` (no auth) serves the OpenAPI 3.1 document; `apps/api/openapi.json` is the committed copy. It is generated from the route registry in `packages/shared/src/api/routes.ts`, and every integration test validates real responses against it. After changing an endpoint run `pnpm --filter @moneymgr/api openapi` and regenerate the clients.
