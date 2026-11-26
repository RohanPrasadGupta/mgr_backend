# MoneyMgr v2 — Backend Plan (living document)

Companion docs: `BACKEND_ANALYSIS.md` (what exists today), `../mgr_frontEnd/PLAN.md` (clients).
Status legend: `[ ]` todo · `[~]` in progress · `[x]` done. Edit freely; add features under **Backlog**.

## 1. Goals
- One backend for **iOS, Android and web**; local first (Docker Compose), AWS later with no code changes.
- Fix the v1 weaknesses: no auth, no real multi-currency, string-matched categories, JS aggregation, inconsistent responses, no tests.
- Server owns all money math (balances, cost basis, P/L, budgets, savings rate).

## 2. Stack (decided unless noted)
| Concern | Choice |
|---|---|
| Language / runtime | TypeScript, Node 22 |
| Framework | NestJS + Fastify adapter (alt: Hono) |
| DB | PostgreSQL 16 |
| ORM / migrations | Drizzle (alt: Prisma) — SQL migrations committed |
| Validation | Zod, shared with clients via `packages/shared`; OpenAPI generated from schemas |
| Cache / queues | Redis, BullMQ (recurring posting, FX refresh, price refresh, reports, notifications) |
| Auth | Email+password (Argon2id), Google, Sign in with Apple; JWT access (15 min) + rotating refresh tokens stored hashed |
| Files | S3 API (MinIO local) — receipts, exports, avatars; presigned uploads |
| Email / push | Mailpit local → SES; Expo Push |
| Observability | Pino, OpenTelemetry, Sentry, `/health` + `/ready` |
| Tests | Vitest, Testcontainers (real Postgres/Redis), supertest |
| Local | Docker Compose: postgres, redis, minio, mailpit |
| AWS later | ECS Fargate, RDS, ElastiCache, S3+CloudFront, SES, Secrets Manager, Terraform/CDK, GitHub Actions |

## 3. Repo layout (monorepo shared with frontend plan)
```
moneymgr/
  apps/api            NestJS (modules below)
  apps/worker         BullMQ processors (same codebase, separate entry)
  apps/web            Next.js          (see frontend plan)
  apps/mobile         Expo             (see frontend plan)
  packages/shared     Zod schemas, types, money utils, constants, generated API client
  packages/config     eslint, tsconfig, prettier
  infra/              docker-compose.yml, terraform/ (later)
```
API modules: `auth, users, accounts, categories, tags, transactions, transfers, currencies/fx, budgets, recurring, goals, debts, investments (assets, holdings, trades, prices), notes, attachments, imports, exports/reports, notifications, insights/ai, billing, admin`.

## 4. Conventions
- **Money**: `amount_minor BIGINT` + ISO-4217 `currency` (never floats). Per-currency exponent table (THB 2, NPR 2, JPY 0…). Every transaction also stores `fx_rate` and `base_amount_minor` (user base currency at write time).
- **Dates**: store `timestamptz` UTC plus `occurred_on DATE` computed in the user's timezone, so month buckets never drift.
- **IDs**: UUIDv7. Soft delete (`deleted_at`) on user data for sync; `updated_at`, `version` on syncable rows.
- **Tenancy**: every table has `user_id` (later `workspace_id`); every query scoped; composite indexes lead with it; Postgres RLS as defence in depth.
- **Envelope**: success `{ data, meta? }`; error `{ error: { code, message, details? } }`; cursor pagination `?cursor&limit`; RFC3339 dates; idempotency key header on POSTs that create money.
- **Versioned** `/v1`. OpenAPI published at `/docs`.

## 5. Data model (v1 schema sketch)
```
users(id, email, password_hash?, name, base_currency, timezone, locale, week_start, created_at, deleted_at)
auth_identities(id, user_id, provider[google|apple|password], provider_user_id)
sessions(id, user_id, refresh_hash, device, expires_at, revoked_at)
workspaces(id, name, owner_id) + workspace_members(workspace_id, user_id, role)   -- phase 6, keep user_id now

currencies(code PK, name, symbol, minor_unit)            -- global
fx_rates(base, quote, rate, as_of, source)               -- daily snapshots
user_currencies(user_id, code, is_default)

accounts(id, user_id, name, type[cash|bank|wallet|card|loan|investment], currency, opening_balance_minor,
         archived, include_in_net_worth, icon, color, sort)
categories(id, user_id, parent_id?, name, kind[income|expense], icon, color, archived)
tags(id, user_id, name) ; transaction_tags(transaction_id, tag_id)

transactions(id, user_id, account_id, category_id?, kind[income|expense|transfer_out|transfer_in],
             amount_minor, currency, fx_rate, base_amount_minor, occurred_at, occurred_on, note,
             transfer_group_id?, recurring_id?, location?, created_at, updated_at, deleted_at, version)
attachments(id, user_id, transaction_id, s3_key, mime, size)
recurring_rules(id, user_id, template jsonb, rrule, next_run_on, end_on?, active)
budgets(id, user_id, category_id?, period[month|week|custom], amount_minor, currency, start_on, end_on?, rollover)
goals(id, user_id, name, target_minor, currency, target_date, account_id?)
debts(id, user_id, direction[lent|borrowed], counterparty, principal_minor, currency, due_on, interest_pct, status)
notes(id, user_id, title, content, linked_type?, linked_id?, pinned, updated_at)

-- investments (replaces stock / coin / SIP / SSF ledgers)
assets(id, symbol, name, class[stock|crypto|fund|sip|retirement|gold|fd|other], exchange, currency)   -- global catalogue + user-custom
holdings(id, user_id, asset_id, account_id?, cost_method[wavg|fifo|manual])
investment_trades(id, user_id, holding_id, type[buy|sell|dividend|bonus|fee|contribution|withdrawal],
                  quantity, price_minor, fee_minor, currency, traded_on, note, include_in_avg bool)
recurring_contributions(id, user_id, holding_id, amount_minor, months_paid?, day_of_month)   -- SIP / SSF
asset_prices(asset_id, as_of, price_minor, source)

imports(id, user_id, source, status, mapping jsonb, stats jsonb)
notifications(id, user_id, type, payload, read_at) ; push_tokens(user_id, token, platform)
subscriptions(user_id, plan, status, provider, renews_at)  -- RevenueCat webhook
audit_log(id, user_id, action, entity, entity_id, at, meta)
```
**v1 → v2 migration map**: `Data`→`transactions` (account string → `accounts` upsert, category name → `categories` upsert after stripping emoji prefix into `icon`, currency default THB); `Category`→`categories`; `Currency`→`user_currencies`; `Notes`→`notes`; `StockTransaction`→`investment_trades` (`useForAvgPrice`→`include_in_avg`); `StockCapital/CoinCapital`→trades of type `contribution/withdrawal` on cash-in holdings; `SipCapital`→`recurring_contributions/trades` per fund name; `SsfCapital`→trade rows (`amount × monthsPaid`). Seed list of the author's categories is in `../mgr_frontEnd/FRONTEND_ANALYSIS.md` §11 (`categoryMapping.js`). Keep an idempotent migration script `tools/migrate-v1`.

## 6. API surface (v1) — grouped
- **Auth**: `POST /auth/register|login|refresh|logout`, `POST /auth/oauth/{google|apple}`, `POST /auth/forgot|reset`, `DELETE /me` (account deletion + data export).
- **Me/settings**: `GET/PATCH /me`, devices, push tokens.
- **Accounts**: CRUD, `GET /accounts/:id/balance`, archive, reorder.
- **Categories/tags**: CRUD, merge, reorder.
- **Transactions**: `GET /transactions?from&to&accountId&categoryId&type&q&min&max&tag&cursor`, CRUD, bulk edit/delete, `POST /transfers`, attachments (presign).
- **Recurring**: CRUD, `POST /recurring/:id/run-now`, preview next dates.
- **Budgets**: CRUD, `GET /budgets/status?month=`.
- **Insights**: `/insights/summary?period`, `/insights/by-category`, `/insights/trend?months`, `/insights/cashflow`, `/insights/net-worth`, `/insights/savings-rate` (replace v1 `dataPerYear`, `dataAnalysis`, `dataReportAll`).
- **FX/currencies**: `GET /currencies`, `GET /fx?base&quote&date`, user-currency CRUD (single default enforced in a transaction).
- **Goals / debts / notes**: CRUD.
- **Investments**: assets search, holdings CRUD, trades CRUD, `GET /portfolio/summary`, `/portfolio/holdings/:id` (avg cost, qty, realised/unrealised P/L, XIRR), `/portfolio/history`, SIP calculator `POST /calc/sip`, price refresh job.
- **Import/export**: `POST /imports` (upload, detect, map, dry-run, commit), `GET /exports?format=csv|xlsx|pdf&range` (async job + download URL).
- **Sync (mobile)**: `GET /sync/pull?since=`, `POST /sync/push` (batched ops, client ids, version conflict result).
- **Billing**: RevenueCat webhook, `GET /entitlements`.
- **Ops**: `/health`, `/ready`, `/docs`.

## 7. Business rules to implement exactly
- Account balance = opening + Σ(income) − Σ(expense) ± transfers; computed with SQL, cached per account with tag invalidation on write.
- Savings rate = (income − expense) / income (null if income = 0); thresholds in client: ≥20% healthy, 0–20% low buffer, <0 overspending (match v1).
- Cost basis (per holding): `wavg` = Σ(buy qty·price+fees)/Σ buy qty; `manual` = only trades with `include_in_avg`; `fifo` lots. Realised P/L = sell proceeds − cost basis × qty sold; remaining value = basis × remaining qty.
- Coin/crypto transaction charge is a fee on the trade (v1 summed it for both sides; fix).
- SIP calc (annuity-due): `r = annual/12`, `FV = P·((1+r)^n − 1)/r·(1+r)`; `r=0 → P·n`.
- Single default currency per user (transactional update).
- Month/year buckets use `occurred_on` in the user's timezone.
- Reports never load full tables in app memory: SQL `GROUP BY`, indexed by `(user_id, occurred_on)`.

## 8. Security & compliance
Argon2id, refresh-token rotation + reuse detection, rate limits (login, import), Helmet, CORS allow-list per env, zod on every input, RLS, secrets via env/Secrets Manager (no credentials in code — v1 had a hardcoded Atlas host), audit log for auth/billing/deletion, encrypted backups, GDPR-style export + delete, App Store requirements (account deletion, privacy policy). No bank credential storage.

## 9. Phases
**P0 Foundation** — [x] pnpm workspace (Turborepo deferred), [x] docker-compose (pg/redis/minio/mailpit; only pg used so far), [x] Nest+Fastify skeleton, env validation, helmet/cors/rate-limit, /health /ready, [x] Drizzle migrations + currency seed, [x] auth (Argon2id, JWT access, rotating refresh with reuse detection; own implementation, not Better Auth), [ ] CI (lint, test, build), [~] shared package (money, dates, zod schemas done; OpenAPI + generated client todo)
**P1 Ledger** — [x] users/settings (`/me`), [x] currencies + FX (daily USD-based rates from open.er-api.com, cross rates, as-of/approximate fallback, 12h auto refresh, `GET /fx`; explicit `fxRate` still overrides), [x] accounts, [x] categories (sub-categories + tags), [x] transactions + transfers (+ tags, attachments), [x] insights (summary, by-category, trend), [x] v1 importer (`POST /imports/transactions` with dry-run + idempotent dedupe, CLI `pnpm import:v1` for the xls; verified on the real 2,080-row file, totals match to the cent) — Mongo-direct import not built
**P2 Planning** — [x] budgets (month/week/custom, overall or per category incl. sub-categories, ok/warning/over status), [x] recurring (daily/weekly/monthly/yearly + interval, month-end clamping, backfill option, in-process scheduler every 15 min + `POST /recurring/run-due`; no BullMQ yet), [x] goals, [x] debts, [x] notes, [x] reports (JSON; CSV/PDF on the web), [ ] notifications + push (deferred)
**P3 Mobile readiness** — [ ] sync endpoints, [ ] Google/Apple login, [ ] biometric-friendly session handling, [ ] RevenueCat webhook + entitlements
**P4 Investments** — [x] assets + trades (buy/sell/bonus/dividend/fee for unit assets; contribution/withdrawal/dividend/fee for value assets like SIP/SSF/capital), [x] cost-basis engine in `packages/shared` (wavg, FIFO, v1-style `manual` average) with oversell protection, [x] manual prices (`POST /investments/assets/:id/prices`), per-asset + portfolio P/L, return %, XIRR, allocation, [x] v1 importers (stock-transactions, stock-capital, coin-capital, sip-capital, ssf-capital; mongoexport JSON accepted), [x] `POST /calc/sip`, [ ] portfolio value history chart (from recorded trades + manual prices), [ ] scheduled fund contributions (SIP/pension) + reminders. **Decided 2026-11-25: no market-data feeds** — users are in any country, so prices stay manual (stocks/funds: buy/sell, average cost, realised/unrealised P/L from the price the user enters; pension funds like SSF: contributions only). A live crypto price may be added later as an opt-in.
**P5 AI / sharing** — [ ] auto-categorise, [ ] receipt OCR, [ ] insights chat, [ ] workspaces + shared budgets + split expenses
**P6 AWS** — [ ] Dockerfiles, [ ] Terraform (VPC, RDS, ElastiCache, ECS, S3/CloudFront, SES), [ ] staging/prod, [ ] backups, alarms, [ ] load test

## 10. Definition of done (per feature)
Migration + RLS, Zod schema in `packages/shared`, OpenAPI updated, unit tests for money/business logic, integration test against real Postgres, authz test (cannot read another user's rows), logged + traced, documented here.

## 11. Open decisions
- NestJS vs Hono; Drizzle vs Prisma.
- Auth: self-run (Better Auth) vs Cognito from day one.
- Live prices: none for now (manual prices only, any country). Possible later: opt-in crypto price feed.
- Sync design: simple last-write-wins with versions vs CRDT/PowerSync.
- Pricing/tiers (free vs Pro).
- Supported locales at launch.

## 11b. Status log
- 2026-11-24: P0 + most of P1 implemented. 15 API integration tests (real Postgres) + 5 shared unit tests pass; `pnpm build` produces a running `dist/main.js`; verified live register → accounts → 401 without token.
- Known gaps: stricter rate limit on `/auth/*` (global 300/min only), no RLS yet, no email verification/password reset, account/category rows expose `userId`/`deletedAt`, Redis not wired, no CI, no OpenAPI.

- 2026-11-24 (later): FX + importer done. 25 API tests + 6 shared tests pass. Real v1 xls imported into a throwaway user: 2,080/2,080 rows, income/expense totals identical to the spreadsheet, re-run imported 0 (idempotent). Throwaway user deleted.
- FX limits: provider gives latest rates only, so older transactions use the earliest stored rate (flagged `approximate`); history accrues from now. No historical backfill.

- 2026-11-24 (later): budgets + recurring done. 34 API tests + 9 shared tests pass; live smoke on built `dist` OK (rule created, run-due posted 1, budget status correct, smoke user removed).
- Budgets/recurring limits: budgets compare in the user's base currency using stored `baseAmountMinor` (changing base currency later does not restate old budgets); no rollover; no alert delivery yet (state is exposed via `/budgets/status`, push/email needs the notifications module); recurrence is frequency+interval, not full RRULE; the scheduler is per-process (idempotent via deterministic clientId, so multiple instances are safe but wasteful — move to BullMQ/worker in P6).

- 2026-11-24 (later): investments done. 46 API + 21 shared tests pass. Model note: plan's separate `holdings` table was folded into `assets` (one asset = one position, with `costMethod`); trades store no FX rate — portfolio converts at today's rate (flagged `approximate`).
- Investment limits: prices are manual only; portfolio XIRR uses today's FX for all flows and carries unpriced holdings at cost; `wavg` uses a *running* average (v1 used one overall average of all buys, so P/L can differ when buys follow sells); v1 stock-capital/coin-capital are modelled as value assets (`STOCK-CAPITAL`, `COIN-CAPITAL`), not as cash accounts; no historical cost basis in base currency; no tax lots/wash rules.

- 2026-11-24 (later): **OpenAPI.** `packages/shared/src/api/{responses,routes,openapi}.ts` define strict response schemas + a route registry; `GET /openapi.json` serves the generated 3.1 document and `pnpm --filter @moneymgr/api openapi` writes `apps/api/openapi.json` (CI drift check). All integration tests double as contract tests (responses validated against the registry; undocumented routes/status codes fail). When you add or change an endpoint: update the route registry (and response schema), run `pnpm --filter @moneymgr/api openapi`, then `npm run api:sync` in the frontend.

- 2026-11-24 (later): **Account deletion** — `DELETE /v1/me` `{password}` → 204: verifies the password (argon2), then hard-deletes trades, prices, assets, transactions, recurring rules, budgets, categories, accounts, refresh tokens and the user in one DB transaction. 5 wrong passwords per 15 min → 429 (in-memory; move to Redis when running >1 instance). Tests assert every user-owned table is empty afterwards (incl. recurring-posted rows), other users are untouched, email is reusable, and a stale access token yields 401 (FK violation on user_id is mapped to 401). Not done: a data-export endpoint (GDPR portability; the web app offers CSV export), deletion confirmation email, grace period/undo, and revoking third-party sign-in tokens (Apple/Google login isn't built yet).

- 2026-11-24 (later): **CORS fix** — `@fastify/cors` defaults to GET/HEAD/POST only; PATCH/PUT/DELETE preflights from other origins (Expo web, any SPA) failed silently. Methods/headers are now explicit and covered by tests (allowed origin gets PATCH/DELETE, other origins get nothing). The mobile app (`../mgr_mobile`) talks to the API directly with bearer tokens; the Next.js web app uses a same-origin gateway instead.

- 2026-11-25: **`GET /v1/insights/daily?from&to`** → `{from,to,baseCurrency,days:[{date,incomeMinor,expenseMinor}]}` for the dashboard's spending-per-day chart. Zero-filled for every calendar day (SQL `generate_series` left-joined to transactions), buckets by the stored local `occurred_on` date, income/expense only (transfers excluded), range capped at 400 days (`from<=to`, else 422). Registered in the OpenAPI route registry (`getDaily`), `openapi.json` regenerated, 4 new tests (zero-fill, local-day bucketing, transfers excluded, range validation). Now 57 API + 26 shared tests pass.

- 2026-11-25 (later): **Security must-fixes + P2 planning.**
  - *Redis* (`REDIS_URL`, keys under `REDIS_PREFIX`, default `mm:`): `infra/kv.ts` is the one place keys are named — `mm:rl:*` rate-limit counters (@fastify/rate-limit store, so limits hold across instances/restarts), `mm:auth:login-fail:<email>`, `mm:auth:delete-fail:<user>`, `mm:auth:reset:<sha256>`, `mm:auth:verify:<sha256>`, `mm:auth:mail-cooldown:*`; every key has a TTL. Without REDIS_URL an in-memory store is used (tests). Verified against the configured Redis (PONG, keys appear with TTLs).
  - *Auth hardening:* per-IP limit `AUTH_RATE_LIMIT_PER_MIN` (default 10/min, per route) on register/login/forgot/reset/verify/resend/change-password/delete-account; global limit `RATE_LIMIT_PER_MIN` (default 600); sign-in lockout after `LOGIN_MAX_FAILURES` (5) per email for 15 min — counted for unknown emails too so it reveals nothing; account-deletion lockout moved to Redis.
  - *Password reset:* `POST /auth/forgot-password` (always 202, one email/min/account), `POST /auth/reset-password` (single-use token, 1 h, hashed in Redis; revokes every refresh token, verifies the email, lifts the lockout), `POST /me/password` (current password required; signs other sessions out). *Email verification:* sent on sign-up (48 h link), `POST /auth/verify-email`, `POST /me/resend-verification` (cool-down); `User.emailVerified`. Mailer: `MAIL_TRANSPORT=log|smtp|memory` (SMTP → Mailpit locally at :8025).
  - *SheetJS* moved to 0.20.3 from the vendor CDN (npm's 0.18.5 had prototype-pollution/ReDoS advisories); `npm audit` clean.
  - *Tags:* CRUD (case-insensitive unique, usage counts); transactions take/return `tagIds`, list filter `tagId`. *Attachments:* multipart upload ≤10 MB, type sniffed from bytes (JPEG/PNG/WebP/HEIC/PDF; SVG/HTML refused), ≤10 per transaction, download with `nosniff`, `private, no-store`, sandboxing CSP; files on local disk (`UPLOAD_DIR`) behind a `Storage` interface (S3 in P6); deleted with their transaction / account. Transactions now carry `attachmentCount`.
  - *Goals* (manual contributions or tracking a linked account's balance; % / remaining / monthly-needed / status on_track·behind·overdue·reached), *Debts* (lent/borrowed, repayments, overpayment refused, open/overdue/settled, per-currency summary), *Notes* (pinned first, search), *Reports* (`GET /reports?period=month|year`: totals vs previous period, categories with change %, daily/monthly series, top 10 expenses, per account, budgets).
  - Account deletion covers every new table and the user's upload folder. Migration `0004`. **92 API + 26 shared tests**; OpenAPI now 87 operations.
  - Known limits: `trustProxy: true` means the API must only be reachable through the web gateway/load balancer (otherwise X-Forwarded-For can be forged) — tighten to the real hop count on AWS; debts and goal contributions don't post ledger transactions; a category icon can't be cleared (PATCH takes no null); notifications deferred as requested.

- 2026-11-25 (later): **Portfolio history + admin.**
  - `GET /investments/portfolio/history?months=` — month-end value vs money invested, replayed from trades + the latest manual price on or before each date (at cost when unpriced), FX at that date; feeds the web/mobile portfolio chart.
  - *Admin* (migration `0005`): separate `admins` table (argon2 + mandatory TOTP 2FA, secret AES-GCM-encrypted with a key from `ADMIN_SECRET`), admin JWTs on their own key/audience, rotating admin sessions with a hard `ADMIN_SESSION_HOURS` expiry, lockout after 5 failures, replay-protected codes. Append-only `audit_log` (admin, action, target, reason, meta, IP) for sign-ins, failures, every action and every support-view read. User suspension (`users.suspended_at/_reason`): login refused after a correct password (403 `account_suspended`), refresh refused, sessions revoked, access tokens cut off within one TTL via a Redis flag checked by `AuthGuard`. Overview/user detail show counts only; financial data needs a support view (reason, `ADMIN_SUPPORT_MINUTES`, per-admin grant in Redis). CLI `pnpm --filter @moneymgr/api admin create|list|reset-2fa|disable|enable`. 10 admin tests; **101 API tests** pass.
  - Dashboard: new repo `../mgr_admin` (Next.js, web only) — overview, users, user detail + actions + support view, audit log, health; tokens only in httpOnly SameSite=strict cookies.
  - Known limits: no admin roles (every admin can do everything); admins can't be created from the UI; no IP allow-list in the API (put the dashboard behind a VPN / allow-list); audit log has no export or retention policy yet.

- 2026-11-25 (later): **AWS hosting (budget).** Terraform in `infra/aws/terraform` (ap-southeast-1): one `t4g.small` Ubuntu ARM instance (SSM only, no SSH; IMDSv2; 80/443 open), separate encrypted gp3 data disk (`prevent_destroy`, daily DLM snapshots ×7), Elastic IP, ECR ×3 (keep 5 images), private S3 ops bucket (deploy bundle + nightly `pg_dump`/receipts/secrets, DB dumps expire after 30 days), monthly budget alert. On the server: Docker Compose (Caddy auto-HTTPS on `app.|api.|admin.<ip>.sslip.io` or your domain, api, web, admin, Postgres 16, Redis 7) with memory limits and log rotation; secrets generated on the server, never in Terraform state. `infra/aws/deploy.sh` builds arm64 images locally, pushes to ECR, rolls out via SSM. API: `TRUST_PROXY` (production trusts only the compose network `172.28.0.0/24`; forged X-Forwarded-For verified ignored), `dist/migrate.js` + `dist/admin.js` built alongside `main.js`. Web/admin: Next `output: "standalone"` + Dockerfiles. Rehearsed the full stack locally through Caddy HTTPS. Not applied to AWS yet. Limits: email logged only until a domain + SES; single server.

- 2026-11-26: **Request logs, Brevo email, old-app Excel restore.** One log line per request (`LOG_REQUESTS`, `LOG_FORMAT=text|json`, `X-Request-Id`, `rid=` on error stacks; never bodies, headers or query strings). Mail: 10 s SMTP timeouts, a failed "resend verification" answers 503 `email_unavailable` and frees its cool-down, and `MAIL_TRANSPORT=brevo` sends over Brevo's HTTPS API (Render's free plan blocks SMTP). New `POST /imports/notes` (idempotent on title+body) and `POST /imports/categories` (emoji → icon; fills the icon of matching default categories). The backup also carries categories and currencies (currencies are checked, not imported). The old app (moneyMgr + its two backends' new `GET /api/export`) downloads one `.xlsx` backup; the web app's **Import → Restore from old app** imports all of it. Verified end to end on local Mongo → old export → .xlsx → new reader → API: 3 transactions, 1 note, 7 investment records with exact times; re-run imported 0.

- 2026-11-26 (later): **Admin accounts from the admin site.** Migration 0006 adds `admins.role` (owner|admin; existing admins became owners) and `must_change_password`. Owners get an Admins page (add with a one-time password, disable/enable, reset password/2FA, change role; reason + audit on each; never on yourself; last active owner protected). A one-time password locks every admin route except `GET /admin/me` and `POST /admin/me/password` until replaced; the role and the lock are checked on every request. CLI `create` makes owners by default. Verified in the browser against a local API: owner adds an admin → one-time password shown once → new admin enrols 2FA → forced password screen → console without the Admins page.

## 12. Backlog (add ideas here)
- Open-banking aggregation (where supported), Android SMS parsing, home-screen widgets, receipts → line-item split, tax reports, net-worth snapshots, scheduled email reports, shared/family spaces, public API tokens, CSV templates for common banks.
