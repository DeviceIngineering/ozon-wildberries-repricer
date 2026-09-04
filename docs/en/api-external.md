# 🔌 Repricer External API (for the LLM pricing agent)

> Machine-to-machine API for an external service: reading repricer state, managing prices, strategies, and store settings.
> Namespace: **`/api/ext/v1`**. Separate from the web UI (cookie sessions do not work here).

Last updated: 2026-07-16.

---

## 1. Authentication

A single **master key** is passed with every request:

```
Authorization: Bearer <EXTERNAL_API_KEY>
```

(the `X-API-Key: <key>` header is an alternative).

The key is set on the server via the `EXTERNAL_API_KEY` env variable (generate it with `openssl rand -hex 32`).

**Authentication status codes:**
| Code | Meaning |
|---|---|
| `401 unauthorized` | key missing or invalid |
| `403 ip_forbidden` | IP not in the allowlist (`EXTERNAL_API_ALLOWED_IPS`) |
| `429 rate_limited` | rate limit exceeded (120 req/min per IP by default) |
| `503 not_configured` | `EXTERNAL_API_KEY` is not set on the server |
| `503 disabled` | the external API is turned off by the kill switch |

Error format: `{ "error": "message", "code": "machine_code" }`.

### ⚠️ Security (required reading)
- **The key means full control over prices.** Treat it as a secret: never log it, never commit it.
- **HTTPS only.** If you expose the port to the internet, put TLS in front of it (reverse proxy / Let's Encrypt) — otherwise the Bearer key travels in the clear and can be intercepted.
- **IP allowlist** (`EXTERNAL_API_ALLOWED_IPS`) — fill it in for any external access.
- **No sanity cap, by the owner's decision:** the server does NOT check whether a price is reasonable (there is no floor guard). Price correctness is the agent's responsibility. Every mutation is written to the audit log (`external_api_log`).
- **Marketplace tokens are not exposed** through the API (never returned by GET, never accepted by PATCH). Token management and creating/deleting stores are web-UI only.
- **Emergency switch:** the entire external API can be turned off instantly (see `external_api_enabled` in `app_settings`, or via a future button in the UI) without rotating the key.

---

## 2. Data model

- **A product is linked across stores by `offer_id`** (the seller's article number — the same one on WB and Ozon).
- **`cost_price`** — the cost price; global per `offer_id`.
- **`ref_price`** — the reference (target) price; per store. **The repricer holds `ref_price`.**
- The store's platform is the `platform` field: `ozon` | `wildberries` | `yandex`.

**Important note on holding a price:** when you set a price via `POST /stores/:id/prices`, it is written as `ref_price` — the repricer will **hold** (defend) it rather than revert it. If the product has an active experiment strategy (`strategy_type != ref_price`), the engine may move the price: to pin it hard, first switch the product to `ref_price` via `PATCH /products/:offerId/strategy`.

---

## 3. Endpoints

Base URL: `https://<host>/api/ext/v1`

### Reading

#### `GET /health`
State summary.
```json
{ "ok": true, "external_api_enabled": true, "stores_count": 4,
  "stores": [{ "id": "...", "name": "OZON-A", "platform": "ozon",
               "repricer_enabled": true, "kill_switch": false, "last_updated_at": "..." }],
  "global_kill_switch": false }
```

#### `GET /stores`
By default only the fields a decision needs are returned: `id, name, platform, repricer_enabled, strategy_kill_switch, tax_rate, min_margin_percent, last_updated_at`, plus the credential flags. `?full=1` gives the extended view (still without secrets).
List of stores **without secrets**. Secret fields are replaced with the flags `has_ozon_creds`/`has_wb_creds`/`has_ym_creds`.

#### `GET /stores/:id`
Store details (repricer settings, thresholds, kill switch).

#### `GET /stores/:id/products`
The store's products. Query: `page`, `pageSize` (≤500), `sort` (`key:asc|desc`), `search`, `filter` (`all|on_sale|below_ref|no_cost|promo|errors|has_fbo|...`), **`fields`**, **`format`**.

The response includes `management_mode`, `managed_by` and `strategy_type` — the ownership mode is visible right away, with no extra call to `/context` just to read `sku_states`.

```json
{ "data": [{ "offer_id": "SKU-0001", "name": "...", "price": "1035",
             "ref_price": 1035, "cost_price": 414, "min_price": "500",
             "stocks_fbo": 0, "strategy_type": "ref_price", "sales_30d": 12,
             "management_mode": "ref_price" }],
  "meta": { "total": 1025, "page": 1, "pageSize": 50 } }
```

##### Context economy

The full card is 31 fields — roughly **258 tokens per product**. A 1,000-SKU catalog in that shape runs to ~258,000 tokens and simply does not fit into a model's context. Two parameters solve it:

`fields=a,b,c` — return only the listed fields; `null` values are not returned at all.
`fields=default` — the set needed for a pricing decision: `offer_id, price, marketing_price, min_price, ref_price, cost_price, floor_min_price, sales_30d, stocks_fbo, in_promo, promo_price, management_mode`.

`format=compact` — the column names are lifted out of the rows:

```json
{ "data": { "cols": ["offer_id", "price", "ref_price", "cost_price", "floor_min_price"],
            "rows": [["SKU-0001", "1035", 1035, 414, 619],
                     ["SKU-0002", "740", 740, 240, 500]] },
  "meta": { "total": 1025, "page": 1, "pageSize": 500, "format": "compact" } }
```

Measured on live data (500 products in the response):

| Request | Size | |
|---|---:|---:|
| no parameters | 10,196 B | — |
| `fields=default` | 2,767 B | −73% |
| `fields=default&format=compact` | **1,175 B** | **−88%** |

The default format has not changed — existing agents keep working.

#### `GET /stores/:id/sales?window=30`
Daily sales. Without `offer_id` — the top sellers over the window; with `offer_id` — the daily series for that SKU. `window` ≤ 90.

#### `GET /stores/:id/repricer-logs`
Log of repricer runs. Query: `action`, `period`, `page`, `limit` (≤500).

`store_id` and `run_id` are gone from the rows: the first is already in the URL, and the second is a UUID costing about 27 tokens per row. The response's list of runs now lives in `meta.runs`.

#### `GET /stores/:id/pending`
Status of price pushes (post-verification). Query: `status` (`PENDING|VERIFIED_OK|VERIFIED_FAIL|EXPIRED`), `limit` (100 by default, ≤500), `since` (ISO date), **`summary=1`**.

The table accumulates history, so any selection has a ceiling. After a mass push, take the summary instead of every row:

```json
{ "data": { "by_status": { "VERIFIED_OK": 78, "PENDING": 2, "VERIFIED_FAIL": 20 },
            "failures": [{ "offer_id": "SKU-0007", "sent_price": 1200,
                           "actual_price": 1350, "fail_reason": "..." }] } }
```

Checking after a push of 1,000 SKUs: ~120,000 tokens for the full list against ~400 for the summary.

#### `GET /products/:offerId/cross-store`
The product's prices across every store.

### Price management

#### `POST /stores/:id/prices`
Pushes prices straight to the marketplace and records the reference (which the repricer then holds).
```json
// request
{ "updates": [{ "offer_id": "SKU-0001", "price": 1200, "min_price": 600, "old_price": 2400 }],
  "dry_run": false }
```
`min_price`/`old_price` are optional (`old_price` is computed automatically according to Ozon's rules). With `dry_run: true` nothing is sent — you get a `preview` of the computed values instead.
```json
// response
{ "success": true, "sent": 1, "item_errors": [], "dry_run": false }
```

#### `PUT /products/:offerId/master-price`
Sets the reference (master price) in every store carrying the product at once.
```json
{ "master_price": 1200 }
```

#### `POST /stores/:id/repricer/run`
Starts a repricer run. Requires `repricer_enabled = true` on the store (otherwise `400 repricer_disabled`).

### Strategies / kill switch

#### `PATCH /products/:offerId/strategy`
Assigns a strategy. Without `store_id`, it applies to every store carrying the product.
```json
{ "store_id": "...",           // optional; if absent — every store carrying the product
  "strategy_type": "max_profit", // ref_price | max_profit | max_revenue | max_units | liquidation
  "price_min": 1000, "price_max": 2000,
  "target_margin": 30,          // for max_units, %
  "window_days": 30,            // 14 | 30 | 60
  "liquidation_max_loss_pct": 10 // for liquidation
}
```
`strategy_type: "ref_price"` — ends the experiment (hold the reference).

#### `POST /stores/:id/kill-switch`
Store kill switch: `{ "enabled": true }` — stops the store's experiments and reverts to the reference.

#### `POST /kill-switch/global`
Global kill switch: `{ "enabled": true }`.

### Store settings

#### `PATCH /stores/:id/settings`
Repricer settings only. Allowed fields: `repricer_enabled`, `repricer_interval_min`, `update_interval_minutes`, `threshold_drop_percent`, `threshold_rise_percent`, `antiban_enabled`, `min_margin_percent`, `tax_rate`. Any other field (tokens, ids) is **ignored**.

---

## 4. A typical agent cycle

1. `GET /health` — is the service alive, and which stores exist.
2. `GET /stores/:id/products?filter=on_sale` + `GET /stores/:id/sales?window=30` — gather state and demand.
3. Compute prices in the external service.
4. `POST /stores/:id/prices` with `dry_run: true` — verify the computation.
5. `POST /stores/:id/prices` (`dry_run: false`) — push. The price becomes the reference and the repricer holds it.
6. `GET /stores/:id/pending` — confirm the marketplace applied it (after ~3 min).
7. If something goes wrong — `POST /kill-switch/global { "enabled": true }`.

---

## 5. Server setup

```bash
# 1. Generate the key and put it into .env on the server
echo "EXTERNAL_API_KEY=$(openssl rand -hex 32)" >> .env
# 2. (external access) fill in the allowlist
echo "EXTERNAL_API_ALLOWED_IPS=<agent-ip>" >> .env
# 3. Restart the container (or ./deploy.sh)
```

If the port is reachable from the internet, you must put it behind a TLS proxy and fill in `EXTERNAL_API_ALLOWED_IPS`. The key grants full control over prices, and over plain HTTP it travels in the clear.
