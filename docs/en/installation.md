# Installation

From `git clone` to your first working store. Every step was checked against the code.

> This application changes **real prices in real stores.** Work through "First steps" and "Before you go live" before enabling the repricer on a production account.

---

## 1. Requirements

- **Node.js 20 or newer.** `package.json` declares `"engines": { "node": ">=20" }` and `.nvmrc` pins `20`.
- **A toolchain for native modules.** `better-sqlite3` compiles on install through node-gyp, so `python3`, `make` and `g++` must be present:

| Platform | Install |
|---|---|
| macOS | `xcode-select --install` (Command Line Tools; Python 3 is included) |
| Debian / Ubuntu | `sudo apt install build-essential python3` |
| Alpine | `apk add python3 py3-setuptools make g++` |

  On Python 3.12 you may also need **`py3-setuptools` / `python3-setuptools`**: 3.12 removed `distutils`, which the old node-gyp still imports, and setuptools ships a vendored copy that patches it back in. The `Dockerfile` installs that package explicitly for the same reason.

- Nothing else. No database server, no message broker, no external cache — all state is one SQLite file.

---


## Try it first, without a marketplace account

Before wiring up real credentials, you can see the whole application working on
synthetic data:

```bash
npm run demo
```

This seeds `demo.db` with three stores (Ozon, Wildberries, Yandex Market),
42 products and 60 days of sales, then starts the app. The catalogue is built to
show the parts that matter: items priced below their floor, promotions under
cost, products with no cost price, quarantine, and one running price experiment.

Nothing in the demo contacts a marketplace — the credentials are placeholders
and the repricer is switched off for those stores. Log in with the administrator
you created above, or create one against the demo database:

```bash
DB_PATH=./demo.db ADMIN_PASSWORD='at-least-12-chars' npm run seed
```

Rebuild or remove the demo data at any time:

```bash
DB_PATH=./demo.db npm run seed:demo -- --reset
```

The demo refuses to run against a database that already holds real stores.

## 2. Install dependencies

```bash
git clone https://github.com/DeviceIngineering/ozon-wildberries-repricer.git && cd ozon-wildberries-repricer
npm ci
```

`npm ci` rather than `npm install`, so versions match `package-lock.json`. This is where `better-sqlite3` is compiled; if it fails, see "Troubleshooting".

---

## 3. The `.env` file

```bash
cp .env.example .env
```

**Only two variables are mandatory.**

### `BETTER_AUTH_SECRET`

The key that signs session cookies. Generate one:

```bash
openssl rand -hex 32
```

If it is missing (`auth.mjs`): under `NODE_ENV=production` the process **throws and refuses to start**; otherwise it logs a warning and runs with unsigned sessions — acceptable for local development, for nothing else.

### `BETTER_AUTH_URL`

The public base URL of the app — exactly the address you open in the browser. Defaults to `http://localhost:3001`.

**If it does not match the real address, login silently fails.** The symptom is distinctive: the login form accepts the password, shows no error, and after a page reload you are logged out again. The cause is that better-auth sets the cookie for its `baseURL`, and the browser neither stores nor returns it. Two practical rules follow:

- in production the URL must be `https://…` — only over HTTPS is the session cookie marked `Secure`;
- if you reach the app through a public domain, `BETTER_AUTH_URL` is that domain, not `http://localhost:3001` and not an IP address.

The same variable seeds the CORS allowlist: `TRUSTED_ORIGINS` falls back to it when unset. Never use `*` — combined with `credentials: true` it would hand the session cookie to any website.

### Everything else (all with defaults)

| Variable | Purpose |
|---|---|
| `PORT` | API port, default `3001` |
| `NODE_ENV` | `development` / `production` |
| `DB_PATH` | SQLite file, default `./ozon.db`, created automatically |
| `UPLOAD_DIR` | directory for uploaded price spreadsheets |
| `TRUSTED_ORIGINS` | comma-separated allowed origins, defaults to `BETTER_AUTH_URL` |
| `FORCE_PUBLIC_DNS` | `1` routes every DNS lookup of the process through 8.8.8.8 / 1.1.1.1 |
| `EXTERNAL_API_KEY` | bearer key for the external API. **Empty = the external API is off** (`503`) |
| `EXTERNAL_API_ALLOWED_IPS` | comma-separated IP allowlist; empty accepts any source |
| `EXTERNAL_API_RATE_PER_MIN` | requests per minute per IP, default `120` |
| `S3_*`, `BACKUP_RETAIN`, `BACKUP_HOUR` | daily backup to S3-compatible storage; empty `S3_ENDPOINT` disables it |
| `SENTRY_DSN_BACKEND`, `VITE_SENTRY_DSN` | Sentry; empty disables it |
| `VITE_API_TARGET` | development only: where the Vite dev server proxies `/api` |

---

## 4. There is no migration command

**The project has no migration command.** No `npm run migrate`, no migrations directory, no schema version table.

The schema is created and updated **automatically when the process starts**: loading `db/connection.cjs` runs `initSchema()` (all `CREATE TABLE IF NOT EXISTS` statements and indexes) and `runMigrations()` (idempotent `ALTER TABLE … ADD COLUMN`, swallowing the "duplicate column name" error). The auth tables are created by better-auth itself in the same database file when `auth.mjs` is imported.

In practice:

- the first run in an empty directory simply creates `ozon.db` — no preparation needed;
- upgrading the application needs no manual database work, just a restart;
- there is no way to roll a migration back from inside the app — the only route back is a copy of the database file.

Details are in [Architecture](architecture.md), "How migrations work".

---

## 5. The first administrator

There is no self-service sign-up in the UI: the login page only signs you in, and further users are created by an administrator (**Settings → Users**, through the better-auth admin plugin). So the very first account is created from the command line:

```bash
ADMIN_PASSWORD='your-strong-password' npm run seed
```

What `seed-admin.mjs` does:

- **requires `ADMIN_PASSWORD` of at least 12 characters** — otherwise it prints a hint and exits with code 1. There is deliberately no default password: this account can change prices on every connected store;
- reads `ADMIN_EMAIL` (default `admin@example.com`) and `ADMIN_NAME` (default `Admin`);
- creates the user through better-auth and then sets `role = 'admin'` with direct SQL;
- is safe to re-run: on an existing user it prints "Admin user already exists, skipping".

The variables can also live in `.env` — the script reads them from the same place the app does.

---

## 6. Running in development

```bash
npm run dev:all
```

That is `concurrently` running two processes:

- `npm run server` → `node server.cjs`: API and scheduler on **:3001**;
- `npm run dev` → Vite: the UI on **:5173**.

Open **:5173**. The Vite dev server proxies `/api` to the backend; the target comes from `VITE_API_TARGET` (default `http://localhost:3001`). Change it if the API listens on another port or another machine.

You can also run them separately, in two terminals:

```bash
npm run server   # API + scheduler only
npm run dev      # UI only
```

Worth knowing: **the scheduler starts together with the API**, not separately. The moment `npm run server` is up and the database holds a store with the repricer enabled, the system starts talking to the marketplace. On an unfamiliar database, start with the repricer switched off.

For production, `npm run build` (`tsc -b && vite build`) emits static files into `dist/`, which Express serves itself — no separate web server for the frontend.

---

## 7. Docker

For a local stack, two commands:

```bash
cp .env.example .env      # fill in BETTER_AUTH_SECRET
docker compose up --build
```

Inside: a multi-stage build on `node:20-alpine`, the frontend built in stage one, only production dependencies in stage two. Data lives in named volumes `repricer_data` (`/app/data/repricer.db`) and `repricer_uploads`. The port is published as `${PORT_PUBLISHED:-3001}:3001`. `stop_grace_period: 30s` matches the graceful shutdown in code, which force-exits after 25 seconds.

For production, add the overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

The overlay requires an explicit `BETTER_AUTH_URL` (`:?set the public https:// URL`) and switches Sentry to `production`.

**TLS is mandatory.** The container speaks plain HTTP and does not terminate TLS. Put a reverse proxy in front of it (nginx, Caddy, Traefik) and set `BETTER_AUTH_URL` to the `https://` address — only then is the session cookie marked `Secure`. Do not expose port 3001 directly to the internet.

If the host's resolver cannot reach marketplace APIs, `docker-compose.prod.yml` carries a commented-out `dns: 8.8.8.8 / 1.1.1.1` block, and the app has `FORCE_PUBLIC_DNS=1`.

---

## 8. Connecting a store

Stores are added in the UI: **Settings → Add new store**. The first choice is the platform, which decides the rest of the fields (`src/components/settings/StoreForm.tsx`).

Fields common to all platforms: store name, update interval (10 minutes / 1 hour / 6 hours / 24 hours), repricer settings (interval, deviation thresholds), the `tax_rate` and `min_margin_percent`, and the promotion-handling flags.

### Ozon

| Field | Where to get it |
|---|---|
| **Client ID** | Ozon seller account → **Settings → API keys** |
| **API Key** | the same page, when creating a Seller API key |

The key needs access to product and price methods: the repricer reads `/v5/product/info/prices` (prices, commissions, logistics, acquiring) and writes `/v1/product/import/prices`, while the monitor additionally fetches visibility and promotions.

The "Antiban" checkbox (`antiban_enabled`) exists for Ozon only; it slows the catalogue crawl down — the batch size drops from 100 to 50 products and the pause between batches grows from 500 ms to 3 s.

### Wildberries

| Field | Where to get it |
|---|---|
| **WB API token** | seller account → **Settings → API access** |

One token, but it must carry **four access categories**. The form label and the comment on the `wb_api_key` column in `db/connection.cjs` list the same set:

- **Content** — product cards (`content-api`): `nmID`, `vendorCode`, the `subjectID` category, dimensions (which give the volume used for logistics);
- **Prices and discounts** — reading and writing the `price`/`discount` pair and the price quarantine list (`discounts-prices-api`);
- **Analytics** — WB warehouse stock via the asynchronous `warehouse_remains` report, and other reports (`seller-analytics-api`);
- **Promotion** — promotions (`dp-calendar-api`).

Paste the token as issued; the client accepts both `<token>` and `Bearer <token>`.

An important identifier note: for WB, `products.ozon_id` holds the **nmID** and `offer_id` holds the **vendorCode**. Your price list must be keyed by `vendorCode`.

### Yandex Market

| Field | Where to get it |
|---|---|
| **Business ID** | seller account: the business (cabinet) identifier |
| **Campaign ID** | the store/campaign identifier inside that cabinet |
| **Api-Key (OAuth token)** | seller account → Partner API section |

All three are required: Yandex ties access to a campaign rather than to a seller, which is why price updates are issued with a `campaignId` instead of an Ozon-style "client id + key" pair.

Yandex stores also carry their own settings: `ym_boost_cap_percent` (boost buffer ceiling, default 30%), `ym_floor_max_raise_percent` (maximum price increase per run, 20%) and `ym_promo_exit_enabled`.

### Ozon Performance API (advertising) — separate

Ozon advertising lives on a different host with **different credentials**: `client_id` and `client_secret` are issued in the **advertising cabinet → Settings → API keys** and are not the Seller API keys. The store form has no fields for them; they go into `app_settings` under `perf_api_<store_id>`:

```bash
node -e "require('./db/strategies.cjs').setAppSetting('perf_api_<store_id>', JSON.stringify({client_id:'...',client_secret:'...'}))"
```

After that the advertising CLI works:

```bash
node scripts/adsCut.cjs <store_id> --list               # list campaigns only
node scripts/adsCut.cjs <store_id>                      # dry run: prints the plan, changes nothing
node scripts/adsCut.cjs <store_id> --apply --factor=0.5 # apply: halve the budgets
```

The host is `api-performance.ozon.ru` (the old `performance.ozon.ru` is not used); the `client_credentials` token lives 30 minutes and is cached in process memory.

---

## 9. First steps after connecting

### 9.1. Synchronise

Trigger a sync for the store (or wait — the scheduler checks `update_interval_minutes` every minute). The sync pulls products, current prices, stock and statuses into the local database. Nothing else works until it has run: the repricer matches items by `offer_id` from the database.

### 9.2. Reference prices and unit costs

Download the Excel template (**Settings → price import → template**); the server builds it from the store's current catalogue. The columns, with the wording from the code:

| Column | Required? |
|---|---|
| `Артикул` (SKU) | do not edit |
| `Название` (name) | informational |
| `Цена сейчас` (current price) | informational, not imported |
| `Цена` (price) | **required** — the reference price the repricer restores to after a drop |
| `Старая цена` (old price) | optional |
| `Мин. цена` (min price) | optional |
| `Себестоимость` (unit cost) | optional, but see below — the repricer will not price below it |

The parser is forgiving about formatting: `"1 300,50"` (including non-breaking and thin spaces) reads as `1300.5`, and columns are matched by regular expressions, so `offer_id` / `price` / `cost` work as headers too.

There are two upload modes: reference-only (`ref-only`), which does not send anything to the marketplace, and a full import. For **Wildberries a full import still does not push prices**: it records only the reference price and unit cost, and the repricer sends prices later — a direct push would break the `price`/`discount` pair and could land the item in price quarantine.

### 9.3. What the repricer will not touch

The two conditions people ask about most:

- **Without `ref_price` an item is not considered at all.** The repricer builds its working set from items that have a reference price; if none do, the run ends with the warning "Нет эталонных цен в БД. Загрузите цены через импорт Excel." (no reference prices in the database — import them from Excel).
- **Without `cost_price` no floor is computed.** The item stays in service — its price will still be restored to the reference — but the "never sell below cost" protection **does not apply to it**. On top of that, with the `policy_require_floor` policy in force the external API rejects a price write for such a SKU with the code `no_floor`.

The repricer also skips items in a promotion (`skipped_promo`), in quarantine (`skipped_quarantine`), items whose reference price is below cost (`skipped_below_cost` — almost always a typo in the spreadsheet), SKUs in `disposal` mode, and items driven by the strategy engine (`in_experiment`).

One more Ozon-specific detail: the floor is computed only when `tax_rate > 0`. Leave the store's tax rate at zero and no break-even price is calculated for Ozon at all. For Wildberries and Yandex a zero rate means "0%" and the protection keeps working.

---

## 10. Before you go live

Work through this list before enabling the repricer on a production store.

**1. Dry runs** exist at several levels:

- **External API:** `POST /api/ext/v1/stores/:id/prices` has `dry_run` defaulting to **`true`** — a forgotten field must not move real prices. The response contains a `preview` of what would have been sent.
- **Price import:** first a `preview` (the file is parsed and shown as a table), then the save; the `ref-only` mode writes the reference and sends nothing.
- **Advertising:** `node scripts/adsCut.cjs <store_id>` without `--apply` prints the plan.
- **Yandex floor:** `node scripts/ymFloorDryCheck.cjs "<store name>"` is read-only: it computes the floor on real data and prints a table without writing anything.

**2. Kill switches.** There are several, at different levels:

| Level | How to turn it off |
|---|---|
| Store repricer | clear `repricer_enabled` in the store settings |
| Pricing strategies, one store | `POST /api/stores/:id/strategy/kill-switch` (or `POST /api/ext/v1/stores/:id/kill-switch`) — all experiments for the store stop and prices return to the reference |
| Pricing strategies, globally | `POST /api/strategy/kill-switch` (or `POST /api/ext/v1/kill-switch/global`) — a flag in `app_settings` |
| The external API as a whole | remove `EXTERNAL_API_KEY` (→ `503 not_configured`) or clear the runtime flag `external_api_enabled` in `app_settings` (→ `503 disabled`) |

**3. Snapshot rollback.** Before every bulk operation the system snapshots the current prices of the affected items into `price_snapshots`. To inspect and roll back:

```
GET  /api/stores/:id/snapshots
GET  /api/stores/:id/snapshots/:snapshotId
POST /api/stores/:id/snapshots/:snapshotId/rollback
```

The UI exposes this as the snapshot history on the products screen. A rollback sends the snapshot's prices back to the marketplace — it is an ordinary price write and subject to all the same platform constraints.

**4. Verification.** Three minutes after prices are sent, the verifier reads them back and marks each record `VERIFIED_OK` / `VERIFIED_FAIL` (1% tolerance). After your first live push, check the pending list — it is the fastest way to confirm the marketplace really accepted the prices instead of returning a polite `200`.

**5. Backups.** With `S3_*` configured, the database is uploaded daily at `BACKUP_HOUR` (default 03:00) and `BACKUP_RETAIN` copies are kept. Without S3, copy the `DB_PATH` file (together with `-wal` and `-shm`) while the process is stopped.

---

## 11. Troubleshooting

### `better-sqlite3` fails to build

Symptoms: `npm ci` dies in node-gyp with `gyp ERR!`, `Python not found` or `ModuleNotFoundError: No module named 'distutils'`.

- Install the build tools from §1.
- On Python 3.12, add `setuptools` (`python3-setuptools` / `py3-setuptools`) — it restores the removed `distutils`.
- Check the Node version: 18 and older may fail to build; 20+ is required.
- Switching Node major versions requires a rebuild: `rm -rf node_modules && npm ci`.

### Login does nothing and shows no error

Almost always `BETTER_AUTH_URL`. It must be **exactly the address open in the browser** — scheme, host and port. Check that:

- behind a reverse proxy it is the external `https://` address, not `http://localhost:3001`;
- a session cookie actually appears in the browser after signing in;
- if the frontend is served from a different address (a Vite dev server on `:5173` pointing at an API elsewhere), add that address to `TRUSTED_ORIGINS` as a comma-separated entry, or CORS will reject the request with `Origin not allowed`;
- in production the process will not even start without `BETTER_AUTH_SECRET` — check the first lines of the log.

### Marketplace API domains do not resolve

Symptoms: entries in `api_logs` with no HTTP status and codes such as `EAI_AGAIN`, `ENOTFOUND`, `ENODATA`. The usual culprit is Docker's internal DNS proxy (`127.0.0.11`), which resolves some Ozon and Yandex domains inconsistently.

The fix is `FORCE_PUBLIC_DNS=1`: the process sends all lookups to 8.8.8.8 / 1.1.1.1. It is off by default because it changes resolution for the entire process. The container-level alternative is to uncomment the `dns:` block in `docker-compose.prod.yml`.

Yandex is a special case that is already handled: the client forces IPv4 (`dns.resolve4` with five retries 200 ms apart) because `dns.lookup` returned IPv6 only on some hosts and Yandex `ENODATA` responses are often transient.

### `429` from Wildberries

WB enforces a strict limit across the whole seller account. The client already keeps a **process-wide** queue: at least 1200 ms between any two WB requests (about 5 per 6 seconds), plus up to three retries honouring `X-Ratelimit-Retry` or backing off exponentially.

If you still see many `429`s:

- check whether **another** tool of yours uses the same token — the throttle only covers this process;
- make sure two instances of the app are not running against one database (which is not allowed anyway — see [Architecture](architecture.md));
- increase the store's sync and repricer intervals: fewer runs, fewer requests.

### Other

- **`503 not_configured` on `/api/ext/v1/*`** — `EXTERNAL_API_KEY` is unset. `503 disabled` — the runtime flag `external_api_enabled` is off.
- **`409 context_stale` on a price write** — the context changed; re-read `GET /context` (the fresh context is included in the error body) and retry. This is normal behaviour, see [External API](api-external.md).
- **"The repricer does nothing"** — read the run summary in the logs: the `REPRICER_SUMMARY` line breaks every item down by outcome (`ok`, `corrected`, `skipped_promo`, `skipped_quarantine`, `skipped_below_cost`, `skipped_no_price`, `fetch_errors`), and each item lands in exactly one bucket.
- **Ozon returned 200 but the price did not change** — look in `api_logs` for an entry containing `items rejected by Ozon`: per-item rejections arrive inside a successful response and are parsed out separately.

---

## Related documents

- [Architecture](architecture.md)
- [User Guide](user-guide.md)
- [External API](api-external.md)
- [LLM Agent Instructions](llm-agent.md)
- [Pricing Strategies](strategies.md)
