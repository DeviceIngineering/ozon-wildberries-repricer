# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Demo mode.** `npm run demo` seeds a synthetic catalogue — three stores, 42
  products, 60 days of sales, including items below floor, promotions under
  cost, missing cost prices and a running experiment — and starts the app, so
  the whole thing can be evaluated without a marketplace account. It refuses to
  run against a database that holds real stores, and the demo stores have the
  repricer switched off so nothing reaches a marketplace.
- Screenshots in the README, generated from that demo data.
- Trilingual documentation (English, Russian, Chinese) covering installation,
  usage, architecture, pricing strategies and the external API.
- `docker-compose.yml` for local development, with the production overlay split
  into `docker-compose.prod.yml`.
- `policy_require_floor`: a price write for a SKU whose break-even is unknown is
  now rejected instead of silently accepted.
- Continuous integration: lint, typecheck, tests, build, Docker image, and a
  guard that fails the build if a credential, database or spreadsheet is
  committed.
- `npm run seed` and `npm run typecheck` scripts.
- Tests for `lib/priceFloor.cjs`, previously the only one of the three pricing
  models without coverage.
- Keyboard access: visible `:focus-visible` rings, sortable table headers
  reachable by keyboard with `aria-sort`, labels on icon-only buttons, sidebar
  labels revealed on focus, and `prefers-reduced-motion` support.
- Responsive breakpoints for the header, sidebar and layout.
- Confirmation dialogs on the kill switch and on bulk promotion exit.

### Changed
- **Breaking.** `dry_run` now defaults to `true` on external API price writes.
  Clients that relied on the previous default must pass `dry_run: false`
  explicitly.
- **Breaking.** `ADMIN_PASSWORD` is required to seed the first administrator and
  must be at least 12 characters. The previous default password is gone.
- `BETTER_AUTH_SECRET` is now validated at startup; production refuses to run
  without it.
- CORS and `trustedOrigins` are restricted to configured origins instead of
  reflecting any origin alongside session credentials. Outside production the
  Vite dev origin is added automatically, since the UI and the API are served
  from different ports during development.
- The public DNS override is opt-in via `FORCE_PUBLIC_DNS=1` rather than always
  on — it used to reroute every lookup the process made.
- The Vite dev server proxies to `localhost:3001` by default, configurable
  through `VITE_API_TARGET`.

### Fixed
- **`.env` was never read.** There is no dotenv dependency, and variables only
  ever arrived through Docker's `environment:` block — so outside Docker
  `cp .env.example .env` did nothing: the server opened the default database
  while `npm run seed` wrote the administrator into another one, and login
  failed with no indication why. Added a dependency-free loader; real
  environment variables still take precedence.
- **The Ozon price floor was silently disabled when the tax rate was zero.**
  `computeFloorMinPrice` treated `0` as "not set" and returned `null`, so sellers
  on a patent, self-employed or VAT-exempt regime got no floor protection at all
  on Ozon — while Wildberries and Yandex Market kept protecting them. Zero is now
  a real rate, and the case is covered by tests.
- `setupFiles` in the Vitest config resolved against the outer workspace when the
  project was checked out inside another repository, which made the whole suite
  fail to start.
- `lib/__tests__/apiKeyAuth.test.mjs` transitively opened the database at the
  default path, leaving a stray `ozon.db` in the repository root after every run.
- A donut chart segment offset was accumulated in a mutable variable during
  render; it is now derived from the segment list.

### Removed
- The order-picking module and its MoySklad integration. It was a separate
  domain that shared little with pricing.
- The unused `sqlite3` dependency, which sat next to `better-sqlite3` and
  compiled from source on every install.

## [3.0.0]

First public release. Extracted from a private repository that had been running
three live stores since March 2026; earlier history is not published because it
contains credentials and commercial data.

Includes: the reference-price repricer for Ozon, Wildberries and Yandex Market;
per-platform break-even floors; promotion auto-exit with an allowlist; the
cross-platform master price; Bayesian ladder price experiments; the decision
cockpit; price-application verification; API self-diagnostics; the external HTTP
API with the multi-agent governance layer; and S3 backups.
