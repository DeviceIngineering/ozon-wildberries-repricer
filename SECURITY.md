# Security Policy

## Reporting a vulnerability

Open a [security advisory](../../security/advisories/new) on GitHub, or email the maintainer listed in `package.json`. Please do not open a public issue for a vulnerability.

Expect an acknowledgement within a few days. This is a small project maintained by one person alongside other work — there is no formal SLA, and pretending otherwise would not help you.

---

## What this software can do to you

Read this section before you connect a production seller account. It is not boilerplate.

**It changes prices in your marketplace accounts.** It authenticates with your API keys, and to the marketplace every action is indistinguishable from you performing it manually. A misconfiguration does not produce an error message — it produces a month of selling below cost.

**It stores marketplace API keys in plain text.** Keys live in the `stores` table of the SQLite database, unencrypted, because the process needs them on every scheduled run and there is nowhere to hide a key from a process that must use it. Anyone with read access to the database file has full control of your seller accounts. Treat `repricer.db` exactly as you would treat the keys themselves: restrict file permissions, keep it off shared volumes, and encrypt your backups.

**Its external API is a remote control for your pricing.** A leaked `EXTERNAL_API_KEY` lets the holder move every price in every connected store. It is disabled by default (empty value returns `503`) and should stay that way unless you actually need it.

---

## Deployment requirements

These are not suggestions.

**Terminate TLS in front of the app.** The session cookie is only marked `Secure` when `BETTER_AUTH_URL` is an `https://` address. Over plain HTTP, both the session and any bearer key travel in the clear. Put nginx, Caddy or Traefik in front; do not expose the Node process directly.

**Set `BETTER_AUTH_SECRET` to a real random value.** Generate with `openssl rand -hex 32`. In production the app refuses to start without it. If you ever suspect it leaked, rotate it — every existing session is invalidated, which is the point.

**Set a strong `ADMIN_PASSWORD`.** Seeding aborts below 12 characters, and there is no default. The seeded account can change prices everywhere.

**Restrict `TRUSTED_ORIGINS`.** It defaults to `BETTER_AUTH_URL`, which is correct for most deployments. Never set it to `*`: combined with cookie credentials, that lets any website on the internet act as the logged-in user.

**If the external API is enabled, fill `EXTERNAL_API_ALLOWED_IPS`.** An empty allowlist accepts requests from any source that has the key. The rate limit (`EXTERNAL_API_RATE_PER_MIN`, default 120) is a guard against runaway agents, not against an attacker.

**Do not run it behind a VPN against Ozon.** Ozon's Seller API rules prohibit VPN use and require a static IP from a reputable provider. This is a rule of the platform, not of this software, and violating it risks your seller account rather than your server.

---

## Safety defaults, and how to keep them

The software ships defensive. Each of these can be turned off, and each exists because turning it off once cost real money.

| Default | What it prevents |
|---|---|
| `dry_run` is **on** for external API price writes | A forgotten field silently pushing real prices |
| `policy_require_floor` is **on** | Writing a price for a SKU whose break-even is unknown, because no cost price was entered |
| `policy_price_change_max_pct` = 15 | A single mistaken write moving a price by an order of magnitude |
| `policy_mass_change_limit` = 200 | A bulk operation touching the whole catalogue without explicit confirmation |
| Strategies apply nothing until `auto_apply` is enabled per SKU | An experiment moving prices before you have watched it decide |
| Snapshot written before every bulk write | No way back after a bad send |
| Kill switch, per store and global | No way to stop everything at once |

Before pointing this at a production store, run it for a full cycle with strategies in proposal mode and watch the decision log. The strategy engine's reasoning is written to `strategy_log` on every run, including the decisions it did not apply.

---

## Known limitations

Stated plainly, because you are trusting this with margin.

- **Cost prices are your responsibility.** Every floor calculation is downstream of `cost_price`. A wrong cost price produces a confident, wrong floor. Nothing in the system can detect this.
- **Constants were calibrated against one seller's assortment.** The co-investment share, the discount depth limits, the buyout share used in Wildberries return logistics — all of these were measured on a specific catalogue in 2026. Verify them against your own settlement reports before relying on them.
- **Marketplace APIs change without notice.** The self-diagnostics module detects this after the fact, not before. An endpoint that changes shape rather than disappearing may fail silently.
- **The verification window is three minutes.** A platform that applies a price later than that will be recorded as `VERIFIED_FAIL` even though it eventually succeeded.
- **No audit of who changed what in the UI.** Actions through the web interface are attributed to the session, but there is no per-user change history. The external API does keep a full audit trail in `external_api_log`.
- **Frontend authorization is cosmetic.** Roles hide navigation and routes in the UI; the enforcement that matters happens server-side in `requirePermission`. Do not rely on the frontend for access control.

---

## Supported versions

The `main` branch is the only supported version. There are no backported security fixes to older tags.

---

## Your obligations as an operator

This tool acts under your seller account. Compliance with each marketplace's terms of service — Ozon's Seller API rules, the Wildberries offer agreement, Yandex Market's partner terms — remains yours, including the clauses that make you responsible for actions taken through the API and for any third-party service you connect to your account.

Nothing in this repository scrapes marketplace storefronts. Every request goes to a documented API host under your own credentials. If you extend it, keep it that way: scraping is explicitly prohibited by Ozon's rules, and the consequence lands on your account.
