# MoneyMgr — Backend Analysis (source material for the new project)

Sources analysed (read from code, not just READMEs):

| Repo | Role | Port (config.env) | Mongo DB |
|---|---|---|---|
| `moneyMgrBackend` | Core API: transactions, categories, currencies, notes. Redis response cache. | 8000 (default 5000) | `moneyMgr` @ cluster `moneymgrdb.yqaumak.mongodb.net` |
| `stock_analysis_backend` | Investments API: stock trade ledger, stock capital, coin capital, SIP capital, SSF capital | 8001 (default 5000) | `stocksAnalysis` @ cluster `cluster0.ywmzrpe.mongodb.net` |

Both are **single-user, no auth, no tests, no validation layer, no pagination**. They share **no code and no database**; the frontend is the only thing joining them. Currency is a plain string in every collection; only `moneyMgrBackend` owns the currency list.

> Where the READMEs and the code disagree, this document follows the **code**. Differences are in §9.

---

## 1. Stack (identical in both)

Node.js 18+, Express **5.1**, Mongoose **8.18**, `cors`, `cookie-parser` (registered, never used), `dotenv`, `nodemon` for both `start` and `dev`. `moneyMgrBackend` additionally uses `redis` 5 (cache). Installed but **never imported**: `bcrypt`, `bcryptjs`, `jsonwebtoken` (both repos), `redis` and `xlsx` in stock backend; `xlsx` in core backend is used only by the one-off import script.

CommonJS (`require`), no TypeScript, no lint, no test runner (`npm test` is a stub).

## 2. Process structure

```
server.js   loads config.env → mongoose.connect(hardcoded Atlas URI built from USER_NAME/PASSWORD)
            → (core only) seed currencies if collection empty → http.createServer(app).listen(PORT||5000)
app.js      express.json → cookieParser → cors(allow-list, credentials:true) → mount routers under /api
routes/*    thin: path → controller/service
controller/ (core)   handlers talk to Mongoose directly, res.status().json()
services/   (stock)  return {success, data, message, error}; routes map success→2xx, failure→400/404
```

Env vars actually read: `USER_NAME`, `PASSWORD`, `PORT`, and (core only) `REDIS_URL`. Everything else in `config.env` (`MONGODB_URI`, `JWT_SECRET`, `REDIS_HOST/PORT/PASSWORD`, `NODE_ENV`, `PASSWORD_rohg505`) is dead. The Mongo host/db name are hardcoded in `server.js`.

CORS allow-list (methods `GET, POST, PUT, DELETE, PATCH, HEAD`, headers `Content-Type, Authorization`, `credentials: true`):
- core: `localhost:3000`, `localhost:3001`, `rpgmoney-mgr.netlify.app`, an Elastic Beanstalk URL (ap-southeast-1), an Amplify URL
- stock: `localhost:3000/3001`, `rpgstockanalysis.netlify.app`, `rpgmoney-mgr.netlify.app`

Health: core has `GET /`, `GET /health` (`"OK"`); stock has `GET /` only.

---

## 3. Data model — `moneyMgrBackend` (db `moneyMgr`)

### 3.1 `Data` (collection `datas`) — a transaction
| Field | Type | Rules |
|---|---|---|
| `_id` | ObjectId | auto |
| `date` | Date | required |
| `account` | String | required (UI offers only `"Cash"` / `"Online"`; not an enum) |
| `category` | String | required — **category NAME, not an id**; legacy names carry an emoji prefix e.g. `"🌐 work"`, `"🍜 Food"` |
| `note` | String | optional |
| `currency` | String | required, uppercase, trim, default `"THB"` |
| `type` | String | required, enum `Income` \| `Expense` |
| `amount` | Number | required (no min — negatives allowed) |
| `__v` | Number | Mongoose version key. **No timestamps.** |

No indexes besides `_id`. Every query is a date-range scan.

### 3.2 `Category`
`name` (String, req), `categoryType` (String, req — free text, "Income"/"Expense" by convention), `currency` (String, req, upper, trim, default `"THB"`). No uniqueness; duplicates allowed.

### 3.3 `Currency`
`code` (String, req, **unique**, upper, trim), `name` (req, trim), `symbol` (req, trim), `isDefault` (Boolean, default false). Seeded on first boot when empty: `THB / Thai Baht / ฿ / default`, `NPR / Nepalese Rupee / ₨`.

### 3.4 `Notes` (collection `notes`)
`date` (Date, req, default `Date.now`), `title` (req), `content` (req, plain string with `\n`).

### 3.5 Relationships
**None enforced.** `Data.category` ↔ `Category.name` is a loose string match; `Data.currency` / `Category.currency` ↔ `Currency.code` is a loose string match. Deleting a category or currency never touches transactions, so orphans are normal (the frontend defends with `getCurrencyMenuOptions`, which re-injects an orphan code into dropdowns). Records created before the `currency` field existed have **no** `currency` key in Mongo; there is no backfill, clients must default to `THB`.

### 3.6 Bulk import source (`inserDataExcel.js`, `Money Manager_8-26-25.xls`)
One-off script for importing an export of the Android "Money Manager" app. **2,080 data rows** (verified by parsing the file). Real header: `Date, Account, Category, Subcategory, Note, THB, Income/Expense, Description, Amount, Currency, Account` (`Subcategory` and `Description` are always empty; `Note` is filled on 62 rows; `THB` always equals `Amount`; every row is `Cash`/`THB`). Dates are Excel serials, except 8 rows stored as text `DD/MM/YYYY HH:mm:ss`. Totals: income 611,832.00 THB, expense 591,878.75 THB. Script: `XLSX.readFile` → `sheet_to_json({raw:true})` → Excel-serial→JS Date (via `XLSX.SSF.parse_date_code`, local time) → validates `amount` numeric and `Income/Expense` ∈ {Income, Expense} (header `"Income/Expense"` in the real xls) → `insertMany`. The Mongo URI in the script is an empty template literal (credentials were removed) so it will not run as committed. It defines its own copy of the schema (currency without default/uppercase).

---

## 4. Data model — `stock_analysis_backend` (db `stocksAnalysis`)

All schemas use `{ timestamps: true }` (`createdAt`, `updatedAt`). All `currency` fields: String, required, uppercase, trim.

### 4.1 `StockTransaction` (per-trade ledger)
| Field | Type | Rules |
|---|---|---|
| `stockSymbol` | String | req, upper, trim |
| `stockName` | String | req, trim |
| `type` | String | req, enum `BUY`\|`SELL`, upper |
| `price` | Number | req, min 0 |
| `quantity` | Number | req, **min 1** (integers not enforced) |
| `totalAmount` | Number | req, min 0. `pre('save')`: if `price && quantity && !totalAmount` → `price*quantity`. Note: it is `required`, so validation runs **before** the hook; a create without `totalAmount` fails validation. Callers (the UI) must send it. |
| `investedDate` | Date | req |
| `currency` | String | default **`NPR`** |
| `useForAvgPrice` | Boolean | default false (UI-only state — selects which BUYs feed the displayed avg price) |

### 4.2 `StockCapital` (`stockcapitals`) — cash put into / taken out of the stock account
`date` (req), `amount` (req, min 0), `type` (req, enum BUY\|SELL, upper, default `BUY`), `currency` (default `NPR`). Index `{date:-1}`. `SELL` means withdrawal and is subtracted in totals.

### 4.3 `CoinCapital` (`coincapitals`) — crypto, always THB
`date` (req), `amount` (req, min 0), `transactionCharge` (req, min 0, default 0), `totalAmount` (req, min 0 — computed `amount + transactionCharge` by the service on update; the model hook has the same `!totalAmount` caveat as 4.1), `type` (enum BUY\|SELL, default BUY), `currency` (default **`THB`**). Index `{date:-1}`.

### 4.4 `SipCapital` (`sipcapitals`) — mutual-fund SIP contribution
`name` (req, trim — fund name), `date` (req), `amount` (req, min 0), `currency` (default `NPR`). Index `{date:-1}`. **No `type`** — contributions only.

### 4.5 `SsfCapital` (`ssfcapitals`) — Nepal Social Security Fund contributions *(missing from the stock README)*
`amount` (req, min 0 — per-month amount), `monthsPaid` (req, min 1), `totalAmount` (req, min 0 — **always** recomputed `amount*monthsPaid` in the pre-save hook **and** the service), `dateAdded` (req — when the row was recorded), `paidDate` (req — what the range filters use), `currency` (default `NPR`), `notes` (trim, default `""`). Indexes `{paidDate:-1}`, `{dateAdded:-1}`.

### 4.6 Cross-collection
No joins, no refs. `portfolio/summary` reads only `StockTransaction`. Totals across currencies are naive sums.

---

## 5. API — `moneyMgrBackend` (all under `/api`)

Response style is **inconsistent** per controller (see §8 gotchas).

### 5.1 Transactions & reports (`dataRoutes` → `dataController`)
Route declaration order matters (static routes before `/data/:id`).

| Method | Path | Behaviour | Success body | Errors |
|---|---|---|---|---|
| POST | `/data` | `new Data(req.body).save()`, then Redis `flushDb` | 201 `{message:"success", data}` | 400 `{message}` |
| GET | `/data` | all, sort date desc, **uncached** (cache code commented out) | `{message, data:[…]}` | 400 |
| GET | `/data/:year/:month` | month may be 1–12 or English name (`August`); range = `[YYYY-MM-01Z, +1 month)` UTC; cached `allData:{year}:{month}` | `{message:"success"\|"success (cached)", data:[…]}` | 400 "Invalid month" |
| GET | `/dataPerYear/:year` | per-month sums; **12-length arrays** indexed by `date.getMonth()` (server-local TZ) | `{message, data:{IncomeArray[12], ExpensesArray[12]}}`; cache `financialDatayear:{year}` | 400 |
| GET | `/dataReportAll` | all-time sum per category name split by type; cache `financialYearAll` | `{message, data:{incomeTypes:{cat:sum}, expenseTypes:{cat:sum}}}` | 400 |
| GET | `/dataAnalysis/:year` | same, scoped to year; cache `financial_year:{year}` | **cache miss:** `{message, incomeTypes, expenseTypes}` (top level). **cache hit:** `{message:"success (cached)", data:{incomeTypes, expenseTypes}}` | 400 |
| GET | `/dataAnalysis/:year/:month` | same, scoped to month; cache `financial_year:{year}:{month}` | same dual-shape quirk | 400 invalid month |
| GET | `/data/report?startDate&endDate[&category]` | raw list, `date >= startDate AND date < endDate` (**exclusive end**), optional exact `category` | `{message, data:[…]}` | 400 if dates missing |
| GET | `/data/:id` | one | `{message, data}` | 404 / 400 (bad ObjectId) |
| PUT | `/data/:id` | `findByIdAndUpdate(req.body,{new:true})` — **no runValidators** — then flushDb | `{message, data}` | 404 / 400 |
| DELETE | `/data/:id` | delete, flushDb | `{message, data}` | 404 / 400 |

Cache: Redis, TTL 4 h (`3600*4`), `getRedisClient()` lazily connects a singleton from `REDIS_URL`. **Any write calls `flushDb()` — wipes the whole Redis DB**, not just app keys. Client is created inside controllers, not at boot; a Redis outage makes the cached GET endpoints return 400 (the `getRedisClient()` throw is inside the same `try`). Only `POST/PUT/DELETE /data` invalidate; category/currency writes do not (and don't need to).

Aggregations are done **in JS after `Data.find()`**, not with `$group`; every report loads full documents into memory.

### 5.2 Categories
| POST `/category` | body `{name, categoryType, currency}` (currency falls back to `THB`) | 201 `{message, category}` |
| GET `/category` | **bare array** `Category[]` | 200 |
| PUT `/category/:id` | `{name, categoryType, currency}` (overwrites all three; missing `currency` → `THB`) | 200 `{message, category}` / 404 |
| DELETE `/category/:id` | | 200 `{message}` / 404 |
Errors: 500 `{message, error}`.

### 5.3 Currencies
| POST `/currency` | `{code,name,symbol,isDefault}`; if `isDefault`, `updateMany({}, {isDefault:false})` first (non-transactional; also runs before uniqueness check, so a duplicate code can leave **no** default) | 201 `{message, currency}` |
| GET `/currency` | **bare array** | 200 |
| PUT `/currency/:id` | unsets others if `isDefault` | 200 `{message, currency}` / 404 |
| DELETE `/currency/:id` | no check for usage or for deleting the default | 200 `{message}` / 404 |
Errors: 500.

### 5.4 Notes (non-RESTful paths)
| GET `/allnotes` | sorted date desc | `{message, data:[]}` |
| GET `/getNote/:id` | | `{message, data}` / 404 `{message}` |
| POST `/addNote` | `{title, content, date?}` | 201 `{message, data}` |
| PUT `/updateNote/:id` | partial body, no validators | `{message, data}` |
| DELETE `/deleteNote/:id` | | `{message:"note deleted successfully"}` (no `data`) |
Errors: 400 `{message, errMsg}`; 404 uses the misleading text `"Failed to get Notes"` for all three.

---

## 6. API — `stock_analysis_backend` (all under `/api`)

**Uniform envelope**, produced by `services/*`: success `{success:true, data, message, [count], [summary/total fields]}`; failure `{success:false, message, error}`. Routes map: create → 201/400, list → 200/400, get/put/patch/delete → 200/404 (SIP put/delete → 400 instead of 404), unhandled throw → 500 `{success:false,message:"Internal server error",error}`. Note the services catch every exception, so a bad ObjectId (`CastError`) comes back as the *service's* failure → **404**, not 500.

### 6.1 Stock ledger — `/transactions` (`stockdata.js`)
| POST `/transactions` | create (needs `totalAmount` in body — see 4.1) |
| GET `/transactions?stockSymbol&type&startDate&endDate` | symbol/type uppercased; date filter on `investedDate` with `$gte/$lte`; sort `investedDate` desc; returns `{data,count}` |
| GET `/transactions/:id` | |
| PUT / PATCH `/transactions/:id` | same handler. If `price` **or** `quantity` is truthy → recompute `totalAmount = (price||old.price) * (quantity||old.quantity)`. `runValidators:true` |
| PATCH `/transactions/use-for-avg-price/:id` | body `{useForAvgPrice}` (declared before `/:id`) |
| DELETE `/transactions/:id` | returns deleted doc |
| GET `/portfolio/summary` | per `stockSymbol`: `{stockSymbol, stockName, totalQuantity, totalInvested, transactions[]}`; BUY adds, SELL subtracts quantity **and** `totalAmount` |

### 6.2 Stock capital — `/capital`
POST, GET list (`startDate`,`endDate`,`type`), GET `/:id`, PUT/PATCH `/:id`, DELETE `/:id`, GET `/capital/summary/total`.
List returns `{data,count,…}`; the summary returns `totalCapital = Σ BUY − Σ SELL`, `totalBuyAmount`, `totalSellAmount`, `recordCount`, `firstInvestmentDate`, `lastInvestmentDate`, `averageInvestment = totalCapital / recordCount` (so it is net per record).

### 6.3 Coin capital — `/coin-capital`
Same six routes + `/summary/total`. Signed totals (BUY +, SELL −): `totalAmount`, `totalTransactionCharge` (**always added, never subtracted**), `grandTotal`, plus `totalBuyAmount/totalSellAmount/totalBuyGrand/totalSellGrand`; the `/summary/total` adds `recordCount`, first/last dates, `averageAmount`, `averageTransactionCharge`. List returns these under `summary`. Legacy rows without `type` are treated as BUY (`record.type || "BUY"`). Update recomputes `totalAmount = amount + transactionCharge` when either is present.

### 6.4 SIP capital — `/sip-capital`
POST, GET list (`startDate`,`endDate` → `{data,count,totalAmount}`), GET `/:id`, PUT `/:id` (**no PATCH**), DELETE `/:id`, GET `/summary/total` (`totalAmount`, `count`, `records`).

### 6.5 SSF capital — `/ssf-capital`
POST (computes `totalAmount`), GET list (`startDate`,`endDate` on `paidDate` → `{data,count,totalAmount,totalMonthsPaid}`), GET `/summary/total` (declared **before** `/:id`), GET `/:id`, PUT & PATCH `/:id` (recomputes `totalAmount`), DELETE `/:id`. Summary: `totalAmount,totalMonthsPaid,recordCount,firstPaidDate,lastPaidDate,averageAmount,records`.

---

## 7. Business logic that lives where

| Rule | Where |
|---|---|
| Totals/aggregations for income/expense/category/month/year | **core backend** (JS reduce, cached) |
| Savings rate, net, cumulative net, top-10 categories, 12-month trend, donuts | **frontend** (from raw lists) |
| Average buy price, remaining shares, realised P/L per symbol | **frontend only** (`StocksPage.jsx`) — the backend's `portfolio/summary` is *not* used by the UI |
| SIP returns calculator | frontend only |
| BHT→NPR display conversion | frontend only (manual rate; no FX service) |
| `totalAmount` derivations | backend (stock/coin/ssf) |
| Currency single-default enforcement | core backend (non-atomic) |
| Multi-currency totals | **none** — naive sums everywhere |

## 8. Known gotchas / bugs to NOT carry into the new project

1. **No auth anywhere**; CORS is the only gate. `bcrypt/jwt` are dead deps.
2. **Redis `flushDb()`** on every write; Redis client built inside controllers; Redis failure breaks reads.
3. **Dual response shape** on `/dataAnalysis/:year[/:month]` (cached vs uncached) and on every other endpoint family (bare array vs `{message,data}` vs `{success,data}`).
4. **Category is stored by name**, currency by code — rename/delete causes silent orphaning; reports group by raw string so `"🍜 Food"` ≠ `"Food"`. The frontend has an unused `categoryMapping.js` to normalise emoji-prefixed names.
5. **Timezone**: month ranges are built in UTC (`…T00:00:00.000Z`), but `dataPerYear` buckets with `getMonth()` (server-local). Frontend dates come from a picker in local time → boundary transactions can land in the wrong month on non-UTC servers (the THB/NPR usage suggests UTC+7 / UTC+5:45 users).
6. **No validators on update** (core `findByIdAndUpdate` without `runValidators`), no `amount > 0`, no category-exists check, no account enum.
7. `totalAmount` is `required` but computed in `pre('save')`; creates only work if the client sends it.
8. `updateTransaction` uses truthiness (`updateData.price || …`) so setting `price: 0` is ignored.
9. `useForAvgPrice` PATCH has no PUT variant, yet the frontend tries PUT and falls back to PATCH.
10. Coin `totalTransactionCharge` sums charges for BUY+SELL; `averageAmount` divides a *net* number by record count — misleading stat.
11. Hardcoded Atlas hostnames in `server.js`; `inserDataExcel.js` has an empty URI.
12. Full-collection in-memory aggregation; no pagination on any list; `GET /data` returns every transaction ever (≈2k rows today).
13. No request logging beyond `console.log("[tag] …")`; no rate limit, helmet, input sanitising, or health check on the stock API.
14. `PUT /sip-capital/:id` and DELETE return 400 for not-found, other resources return 404.

## 9. README ↔ code discrepancies (stock backend)
- README omits **`SsfCapital`** and `/api/ssf-capital` entirely (it is mounted in `app.js` and used by the frontend).
- README says Stock capital / Coin capital have no `type`; the **code has `type: BUY|SELL`** on both and the summary math depends on it.
- README says "Coin capital … always THB, SIP no PATCH" — correct; but README lists `/api/capital` summary as `averageInvestment` of totals — in code it is **net**/count.
- README says CORS allows localhost + two Netlify sites — matches code.

## 10. Entity-relationship sketch (logical, not enforced)

```
Currency(code PK-ish) ──< Category.currency
        └──────────────< Data.currency, StockTransaction.currency, StockCapital.currency,
                          SipCapital.currency, SsfCapital.currency, CoinCapital.currency
Category(name) ──< Data.category          (string match)
Data ── Notes: unrelated
StockTransaction(stockSymbol) groups holdings;   StockCapital/SipCapital/SsfCapital/CoinCapital are independent ledgers
```

## 11. Carry-forward recommendations for the new project (derived from the above)

- **Single backend, single DB**, one currency table with FK/`ObjectId` refs from categories, transactions, investment ledgers; store `categoryId`, keep denormalised `categoryName` only for display.
- Money as **integer minor units** (or Decimal128) + ISO currency code; store `fxRate`/`baseAmount` at write time so multi-currency totals are real (the app's biggest functional hole).
- Add **users + auth** (every collection gets `userId`), per-user currency defaults, accounts as a first-class entity (today `account` is a free string with two UI values).
- Replace JS aggregation with Mongo **aggregation pipelines** + `{userId,date}` compound indexes; paginate lists; one response envelope; centralised validation (zod/Joi) and `runValidators` on updates; store dates in UTC and bucket by a per-user timezone.
- Targeted Redis keys with prefix + tag invalidation instead of `flushDb`.
- Move holdings/avg price/realised P/L (currently only in React) into the API (`portfolio/summary` already half-does this) so web/mobile share one definition; make `useForAvgPrice` an explicit "cost-basis method" (FIFO / weighted-avg / selected lots).
- Unify investment ledgers (stock trade, stock capital, coin, SIP, SSF) under an `Investment` + `InvestmentTransaction` model with `assetClass` and `type`; keep SSF's `monthsPaid` as a recurring-contribution feature.
- Features visible as gaps today: budgets, recurring transactions, transfers between accounts, attachments, tags, CSV/Excel **import UI** (the xls importer exists only as a script), live FX, price feeds for holdings (current value / unrealised P/L), goals, alerts.
- Tests (none today), OpenAPI spec, env-driven Mongo URI, health/readiness endpoints on every service, structured logging.
