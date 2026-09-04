# Ozon / Wildberries / Yandex Market Repricer

Automated repricing and price management for sellers on **Ozon**, **Wildberries** and **Yandex Market** — the three largest e-commerce marketplaces in Russia. Русскоязычное описание: **[README.ru.md](README.ru.md)**.

It keeps your prices at the reference level you set, refuses to sell below a break-even floor computed from each platform's real fees, pulls products out of promotions that would push them under cost, and — optionally — searches for a better price by running a controlled experiment on live sales.

**[Русский](README.ru.md) · [中文](README.zh.md)**

> **This software changes real prices in real stores.** Read [SECURITY.md](SECURITY.md) before connecting a production account. Every write is dry-run by default; you have to ask for the real thing.

---

## Why this exists

Marketplaces are not neutral ground. They enroll your products into discounts you did not approve, they take a cut that changes per category and per warehouse, and they charge for boosts through fees that no API endpoint will tell you about directly. A price that looked profitable in a spreadsheet quietly stops being profitable, and you find out at the end of the month.

This project was built to run three live stores. Every rule in it came from losing money on that rule being absent.

---

## What it does

### Holds a reference price

The repricer compares the live marketplace price against your reference price (`ref_price`) and restores it when the platform drifts. Items in a promotion, in quarantine, in an experiment or in disposal mode are skipped, and every SKU lands in exactly one outcome bucket — `ok`, `corrected`, `skipped_promo`, `skipped_quarantine`, `skipped_below_cost`, `rejected` — so the log never lies about what happened.

### Computes a break-even floor per platform

Not one formula with a platform flag. Three genuinely different models, because the economics differ:

| Platform | Model |
|---|---|
| **Ozon** | Commission, logistics and acquiring read from the live `/v5/product/info/prices` response, tax nested on net revenue |
| **Yandex Market** | Tax on **gross** revenue (simplified taxation), plus the actual boost rate reconstructed from `stats/orders` — the tariff endpoint does not return it |
| **Wildberries** | FBO commission by `subject_id`, logistics by box volume, return logistics weighted by buyout share |

A `tax_rate` of zero is treated as zero percent, not as "disabled" — the guard still applies.

### Pulls products out of promotions

Works from the live promotion list on the platform, not from a local mirror that can be stale. Frozen promotions are skipped, partial removals are retried on the next run, and — on Ozon — it also sets the opt-out flag so the platform stops auto-adding products in the first place. A whitelist of allowed promotions and a maximum discount depth keep the campaigns you actually want.

Wildberries has no exit-from-promotion endpoint, so exit is implemented by restoring the `{price, discount}` pair through the Prices API.

### One master price across three platforms

Set the price a buyer should see, and it is expanded into each platform's own rules: Ozon's `price` / `old_price` / `min_price` with the 50% and 2× constraints, Wildberries' base-plus-discount pair (buyer price cannot be set directly), Yandex's `price` with a `discountBase` inside the permitted 5–99% range. Dry-run first, snapshot before sending, one batch per store to respect rate limits.

### Finds a better price by experiment

Most repricers apply a rule. This one can run a search.

At 0.3–5 units per day per SKU, a proper A/B test is statistically impossible — it needs hundreds of sales per price point. So instead: a **within-SKU ladder with Gamma-Poisson Bayesian demand estimation**, event-based stopping, hysteresis and coarse-to-fine step reduction. Decisions are made on the **lower quantile** of the posterior rate rather than its mean, so a small sample cannot talk the engine into a price it has not earned.

Five strategy types: `ref_price` (no experiment), `max_profit`, `max_revenue`, `max_units` under a margin constraint, and `liquidation`. Days confounded by stock-outs, promotions, ad spikes or discount-share shifts are flagged and excluded from demand estimation.

Validated by Monte-Carlo simulation against a known optimum (`scripts/simStrategy.cjs`): the gap to the theoretical best is roughly 2% for `max_profit` and `max_units`, 12% for `max_revenue` — the revenue optimum is genuinely flat.

See [docs/en/strategies.md](docs/en/strategies.md) for the design.

### Verifies that prices were actually applied

Marketplaces return success for changes they did not make. Three minutes after every send, the price is read back and the record is marked `VERIFIED_OK` or `VERIFIED_FAIL`. Ozon also returns HTTP 200 with per-item errors inside the payload — those are parsed out and logged as rejections rather than counted as successes.

### Watches for the API breaking underneath it

An explicit registry maps each repricer function to the endpoints it depends on. Light probes (`limit=1`) run hourly — a 404 means the API changed — alongside a degradation detector that compares current failures against the endpoint's own history. Alerts go to Sentry.

### A decision cockpit, not a metrics dashboard

Nine alert types ranked by money at risk: reference price below cost, promo price below cost, price below floor, platform pushing under floor, changes not applied, quarantine, failed promo exits, missing cost data, missing sales data. Each card carries the amount at stake and the action that resolves it.

### An HTTP control plane for LLM agents

`/api/ext/v1` is a machine-to-machine API behind a bearer key, an IP allowlist and a rate limit — designed for the case where **several LLM agents in several different chats** manage the same catalogue.

Keeping them from overwriting each other is a concurrency problem, so it is solved like one:

- **Versioned context.** Every price write must carry the current `context_version`. A stale one is rejected with `409` and the fresh context is returned in the same response — the same idea as `ETag` / `If-Match`.
- **SKU ownership.** A product in `experiment` or `liquidation` mode may only be written by the agent that owns it; a product in `disposal` is frozen outright.
- **Policy rails.** Maximum change per write, mass-change confirmation above a threshold, floor enforcement, and rejection of SKUs whose floor is unknown.
- **Decision journal and briefing.** Agents record decisions, intents and policies; the server generates a briefing in Markdown and tracks which agent has acknowledged which context version.
- **A single source of truth for profit.** `GET /stores/:id/pnl` is the only sanctioned way to compute it, and it states its own methodology, including what it does not subtract.

See [docs/en/api-external.md](docs/en/api-external.md) and [docs/en/llm-agent.md](docs/en/llm-agent.md).

---

## Setting up a store — a form, not a config file

A store is added from the Settings page: pick the marketplace, paste the keys from your seller account, done. No config files, no restart, no environment variables — keys live in the database rather than in `.env`, so you can register as many seller accounts as you need, each with its own settings.

Most of the settings are about economics, and they are set **per store**, because tax regime and target margin differ from one legal entity to the next:

| Setting | What it does |
|---|---|
| **Tax rate** | Feeds into the break-even calculation. Zero means zero percent (a patent or self-employment regime), not "disabled" |
| **Minimum margin** | What you want to earn on top of the cost price. Raises the price floor |
| **Drop / rise threshold** | How far the price has to drift from the reference price before the repricer steps in. Keeps it from twitching over kopecks |
| **Repricer interval** | How often prices are checked — anywhere from minutes to hours |
| **Boost cap in the floor** | An upper bound on the reconstructed Yandex boost rate, so an anomaly in the statistics cannot inflate the floor |
| **Max price rise per run** | Stops the price from jumping too far in one go |
| **Loss-making promotion guard** | Pull products out of a promotion whose promo price is below cost |
| **Automatic promotion exit** | Pull products out of any promotion that is not on the allowlist |
| **Max discount in allowed promotions** | Even an approved promotion must not cut deeper than this percentage |
| **Anti-ban delay** | Pause between requests to the marketplace |

All of it can be changed on the fly and takes effect on the next run.

---

## Driving prices with an LLM agent

The repricer exposes an external HTTP API (`/api/ext/v1`) designed on the assumption that a language model is on the other end of it. In practice that looks like an ordinary request:

> "Cut prices in store X by 20%"
> "Raise prices across every store by 30%"
> "Test a hypothesis: what happens to this group of products at 15% below the current price"

The value is not that the command can be phrased in words — it is that **the agent cannot do damage with it**. Between the request and the marketplace sit rails that know things the model does not:

**A steep price change is stepped — in both directions.** Marketplaces punish sudden moves, and the repricer knows the thresholds.

Downwards: Wildberries sends a product to quarantine when its price drops by more than 1.5x — the price does not apply at all and the item falls out of search. When the target sits below that threshold, the repricer walks there over several runs, staying just short of the limit each time. This guard did not come from documentation: the experiment engine once tried to drop a price straight to the floor, 40–50% in a single step, and a dry-run pilot caught it before it reached a live store.

Upwards: the increase per run is capped by a per-store setting, 20% by default. "Raise everything by 50%" is carried out over several cycles rather than in one jump.

Between steps the price is read back from the marketplace, so each step starts from what actually applied rather than from what was sent.

**Verification that the price actually landed.** Three minutes after a write, the price is read back from the marketplace. Marketplaces routinely answer "success" to a change they never made; such a write is flagged `VERIFIED_FAIL`, so you see it now rather than finding out a month later.

**Promotions.** A price change can drag a product into a promotion — the marketplace does that on its own. The next automatic-exit cycle (every 5 minutes by default) pulls it back out if the promotion is not on the allowlist, or if the discount is deeper than allowed.

**Limits on the request itself.** A change of more than 15% from the reference price in a single write is rejected. An operation touching more than 200 SKUs requires explicit confirmation. A product with no known cost price will not accept a new price at all — no floor means no protection. Every threshold is configurable.

**It stays clear who did what.** Every agent call is journalled: who, what, how many positions it touched. Before any mass write a price snapshot is taken, and you can roll back to it.

When there are several agents — each in its own chat — they do not overwrite each other's decisions: the context carries a version, a stale write is rejected, and a product under experiment belongs to the agent running it. Details are in the [agent instructions](docs/en/llm-agent.md) and the [API reference](docs/en/api-external.md).

> Separately from the repricer, the author maintains MCP servers for [Ozon](https://github.com/DeviceIngineering/ozon-mcp-server) and [Wildberries](https://github.com/DeviceIngineering/wb-mcp-server), which give a model direct access to seller accounts. This repository contains no MCP server: what it offers is an HTTP API, and an agent can be wired to it however you prefer.
>
> For what else exists in the open for these marketplaces, see [awesome-ru-marketplace-tools](https://github.com/DeviceIngineering/awesome-ru-marketplace-tools).

---

## What it looks like

**The decision cockpit** — not a metrics dashboard. Every card is a problem with money attached and a button that resolves it.

![Decision cockpit](docs/images/cockpit.png)

**The product table** — reference price and its deviation, cost, computed floor, margin, promo flags, stock. Everything the repricer decides on, in one row.

![Product table](docs/images/products.png)

**One master price across three marketplaces.** The same article number is listed on Ozon, Wildberries and Yandex Market; you set the price a buyer should see once, and it is expanded into each platform's own rules. Prices below cost are flagged before anything is sent.

![Master prices](docs/images/master-prices.png)

**A price experiment, with its reasoning.** The log shows what the engine did and why — corridor scan, ladder step, hold while evidence accumulates. Nothing is applied until you switch a product to Auto.

![Pricing strategies](docs/images/strategies.png)

Both themes are supported:

![Light theme](docs/images/cockpit-light.png)

### Try it without a marketplace account

```bash
npm run demo                                             # seeds demo.db and starts the app
DB_PATH=./demo.db ADMIN_PASSWORD='at-least-12-chars' npm run seed   # once, to be able to sign in
```

Seeds a synthetic catalogue — three stores, 42 products, 60 days of sales, deliberately including items below floor, promotions under cost, missing cost prices and one running experiment — into `demo.db` and starts the app. No credentials are involved and nothing contacts a marketplace. The screenshots above are exactly what this produces.

---

## Where to run it

Nothing is required beyond Node.js: one process, one SQLite file. Which leaves two ways to live with it.

**On your own machine.** Good enough for taking a look, trying it against a single store, getting a feel for the logic. The limitation is obvious: the repricer runs only while the computer is on. Close the laptop and nobody is holding your prices, nobody is exiting promotions, and that day's sales are never collected.

**On a rented server (VPS).** This is what the whole thing was built for: it runs around the clock without you. Once a minute it checks whether a repricer run is due; at night it collects sales and takes a backup; every hour it checks whether somebody else's API has broken.

The smallest VPS is enough:

| | Minimum | Comfortable |
|---|---|---|
| CPU | 1 core | 2 cores |
| Memory | 1 GB | 2 GB |
| Disk | 10 GB | 20 GB or more |
| OS | anything with Docker or Node 20 | — |

For disk, the rule of thumb is this: the database grows along with price history, request logs and day-by-day sales. Over half a year of running eight seller accounts, the author's came to roughly 500 MB. Turn on the built-in nightly backup to S3-compatible storage right away.

The server must have **a static IP from a reputable provider, and must not run through a VPN** — that is a direct requirement of the Ozon Seller API rules, and a violation hits your seller account, not this program. There is no need to expose a port: if you want to reach the UI from outside, put a TLS reverse proxy in front of the app (see [SECURITY.md](SECURITY.md)).

Deployment on a server is `docker compose`; details are in the [installation guide](docs/en/installation.md).

---

## Proven in production

This was not written for some hypothetical future — it has been running real trading since March 2026.

- **Eight seller accounts at once:** three on Ozon, two on Wildberries, three on Yandex Market.
- All three marketplaces run in parallel, with different tax settings and different economics.
- There is no fixed limit on how many accounts you can have: they are just rows in a table, each with its own keys and its own schedule.

**An honest word about the scaling ceiling.** In the author's experience it arrives somewhere around **15–20 seller accounts on a single marketplace**: from one IP address the marketplace starts throttling requests. That is an estimate rather than a measured limit, and it depends on catalogue size and how often runs happen. Proxy rotation is not implemented — if you need more accounts, you will have to add it yourself, or spread the accounts across several servers.

---

## Stack

Node.js 20 · Express 5 · better-sqlite3 (synchronous) · node-cron · better-auth
React 19 · Vite 7 · TypeScript 5.9 · CSS Modules — no UI library, no state manager
SQLite, single file, WAL · Docker multi-stage · Sentry (optional)

Roughly 35 000 lines. 155 tests over the pricing maths, the strategy engine, the spreadsheet parser, API-key authentication and the cockpit queries.

---

## Quick start

**Requirements:** Node 20+, and a toolchain for native modules (`python3`, `make`, `g++`) because `better-sqlite3` compiles on install.

```bash
git clone https://github.com/DeviceIngineering/ozon-wildberries-repricer.git && cd ozon-wildberries-repricer
npm ci

cp .env.example .env
# Generate the session secret and put it in .env as BETTER_AUTH_SECRET:
openssl rand -hex 32

# Create the first administrator (password must be 12+ characters)
ADMIN_PASSWORD='your-strong-password' npm run seed

npm run dev:all          # API on :3001, UI on :5173
```

There is no migrate command. The schema and all migrations run automatically when the process starts.

Then open the app, sign in, and add a store under **Settings**. You will need API credentials from the marketplace's seller cabinet — see [docs/en/installation.md](docs/en/installation.md) for which scopes each platform requires.

### Docker

```bash
cp .env.example .env      # set BETTER_AUTH_SECRET
docker compose up --build
```

For production, put it behind a TLS-terminating reverse proxy and set `BETTER_AUTH_URL` to the `https://` address — the session cookie is only marked `Secure` over HTTPS:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

### Tests

```bash
npm test              # vitest
npm run typecheck     # tsc --noEmit
npm run lint
npm run build
```

---

## Configuration

Every variable is documented in [`.env.example`](.env.example). Only two are required: `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`.

Marketplace API keys are **not** environment variables — they are entered per store in the UI and stored in the database. See [SECURITY.md](SECURITY.md) for what that means for how you deploy this.

---

## Documentation

| | English | Русский | 中文 |
|---|---|---|---|
| Installation | [en](docs/en/installation.md) | [ru](docs/ru/installation.md) | [zh](docs/zh/installation.md) |
| User guide | [en](docs/en/user-guide.md) | [ru](docs/ru/user-guide.md) | [zh](docs/zh/user-guide.md) |
| Architecture | [en](docs/en/architecture.md) | [ru](docs/ru/architecture.md) | [zh](docs/zh/architecture.md) |
| **How a price is decided** | [en](docs/en/pricing.md) | [ru](docs/ru/pricing.md) | [zh](docs/zh/pricing.md) |
| Pricing strategies | [en](docs/en/strategies.md) | [ru](docs/ru/strategies.md) | [zh](docs/zh/strategies.md) |
| External API | [en](docs/en/api-external.md) | [ru](docs/ru/api-external.md) | [zh](docs/zh/api-external.md) |
| LLM agent instructions | [en](docs/en/llm-agent.md) | [ru](docs/ru/llm-agent.md) | [zh](docs/zh/llm-agent.md) |

---

## Status and scope

This is working software extracted from a running installation, not a product with a support contract. It was built for one seller's three stores; your catalogue, tax regime and warehouse mix will differ, and several constants in it were calibrated against a specific assortment. Read [docs/en/architecture.md](docs/en/architecture.md) before assuming a default fits you.

The user interface is in Russian, because its users are sellers on Russian marketplaces. Documentation is trilingual. Code, comments and commit messages are being moved to English.

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Disclaimer

This tool acts on your marketplace account, under your API keys, as you. You are responsible for what it does there, including compliance with each marketplace's terms of service and with the offer agreement you accepted as a seller. The authors provide no warranty and accept no liability for lost margin, blocked accounts or any other consequence of running it.

Do not point it at a production store until you have watched it in dry-run mode for a full cycle.

---

## License

MIT — see [LICENSE](LICENSE).
