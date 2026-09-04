# 🎯 Pricing strategies — design specification

> Source of truth for the "dynamic price discovery by experiment" feature.

## Problem
At a fixed target margin (say 30%), the price floor pushes some items so high that sales stop. We need to discover prices from actual sales instead of holding a static reference price.

## Approach (rationale — `docs/` research, methodology)
A strict A/B test is statistically impossible at low volume (λ=0.3–5 units/day) — it would take hundreds of sales per price point. So instead:
**within-SKU ladder (stepwise search) + Gamma-Poisson Bayes + event-based stop + hysteresis.**
- Hold a price until **N_min≈12 sales OR T_max** (the analysis window), then decide.
- The decision is based on the **posterior expected metric** (Gamma-Poisson); we take the lower percentile (p25) → risk aversion toward small samples.
- Large step (±7–10%, coarse-to-fine down to ±3–5%), hysteresis δ≥5%, revert after 2 bad readings.
- The corridor is a narrow window around the working price; **the floor is a hard bottom** (except for `liquidation`).
- λ<0.3/day → not eligible for the experiment (no signal).

## Strategies (`products.strategy_type`)
| Type | Goal | Optimum |
|---|---|---|
| `ref_price` (default) | hold the reference price, no experiment | — |
| `max_profit` | maximize `(price − cost − commission(price)) × units` | interior |
| `max_revenue` ("max sales") | maximize `price × units` (revenue) | interior (elasticity≈1) |
| `max_units` | maximize units subject to margin ≥ target | tends toward the floor at the target margin |
| `liquidation` ("dump") | clear FBO stock at the minimum price | downward, **selling below cost is allowed** |

### The `liquidation` strategy — a special mode
- The user **manually** picks the SKUs and the **allowed loss** (how far below cost price the price may go).
- It bypasses the floor (the only strategy allowed to) within the allowed loss.
- 🔴 **CRITICAL:** liquidation days are flagged `is_dirty=1` + `liquidation_flag=1` in `sales_daily`, and a liquidation history is kept. The engine and any future LLM **must** exclude these days from demand estimation — otherwise the liquidation-driven spike is mistaken for a response to price.

## Analysis windows
Selectable: **14 / 30 / 60 days** (per product or per store). Affects how λ and the metrics are computed.

## Safety
- **Gate:** the first N cycles are dry runs (the engine PROPOSES a price and manual approval is required), then auto-apply kicks in.
- **Kill switch:** three levels — global / per store / per SKU. Instantly halts the experiment and reverts to `ref_price` / the last known-safe price.
- **Floor guard:** no price (except liquidation) ever goes below the floor.
- **Pilot:** auto-select the top N (~20) SKUs by sales volume, plus manual additions.
- **Freeze the other levers:** on pilot SKUs, do not touch promotions or ads (price is the only lever).

## Confounders → `is_dirty_flag` (do not use the day to draw price conclusions)
Stockout, promotion day, ad/boost spike, WB loyalty discount (SPP) shift, liquidation. Demand is computed from "clean" days only.

## Data: `sales_daily` (append-only, 1 row per SKU × day)
Day-level granularity is mandatory (aggregates destroy any chance of untangling confounders). This is both the engine's input and the dataset for the LLM.
Fields: `store_id, product_id, offer_id, marketplace, date, units, revenue, profit, price_seller, price_buyer_est, cost_unit, commission_pct, floor, ceiling, promo_flag, promo_price, ad_spend, boost_pct, stock_qty, in_stock_flag, spp_pct(WB,null), comp_price(null), experiment_id, step_idx, is_dirty_flag, liquidation_flag, posterior_lambda_mean, posterior_lambda_p25`.

## Sales sources per marketplace
- **Ozon:** `/v1/analytics/data` (metrics: ordered_units/revenue; dimension: sku, day).
- **WB:** `nm-report` (orders/buyouts by nmID/day). ⚠️ count **buyouts**, not orders (returns).
- **Yandex:** extend `fetchOrdersEconomics` (already exists, 7 days → window).
⚠️ Observed demand responds to the **buyer-facing price** (WB: ×(1−SPP); Ozon: marketing_price; YM: boost), while what we move is the seller price. Log both prices separately.

## Engine validation (Monte Carlo)
Simulation `scripts/simStrategy.cjs` over synthetic Poisson demand, measuring the gap in the METRIC VALUE vs the theoretical optimum:
- **max_profit: ~2%**, **max_units: ~2%** — excellent.
- **max_revenue: ~12%** — acceptable: the revenue optimum is flat, plus the fundamental noise of low volume (a single reading per price is fooled by ±2σ swings). Mitigations: the manual gate, accumulating data over time (the posterior tightens), and the λ threshold.
Engine: an initial corridor scan phase (brackets the optimum) → ladder refinement; a weak prior plus a minimum number of observation days (otherwise low-price points are underestimated).

## What is implemented
- **Data model:** `sales_daily`, `experiments`, `strategy_log`, strategy fields on `products`, kill switch.
- **Sales collection** across all three marketplaces, with backfill and a daily job: `salesCollector.cjs` plus the fetchers.
- **Engine:** `lib/bayesPoisson.cjs` (Gamma-Poisson, Wilson–Hilferty quantile, Acklam inverse normal) and `lib/strategyEngine.cjs` (corridor scan, ladder, hysteresis, objective functions, dirty-day filter). Pure maths with no network and no database — which is why it can be tested and simulated.
- **Orchestration:** `strategyRunner.cjs` — unit economics, the Wildberries quarantine cap, the `auto_apply` gate, per-store and global kill switches.
- **Observability:** `strategy_log` records the decision for every SKU on every run; the `/strategies` panel.
- **Tests:** unit tests for the engine and the Bayesian layer, a deterministic ladder convergence test, safety properties (corridor ceiling, liquidation boundary, floor > 0, unreachable margin for `max_units`), and the Monte Carlo simulation.

## Launching the pilot (once enough history has accumulated)
1. `/strategies` → store → "Select pilot" (top N by sales) OR assign manually.
2. For several days the engine accumulates clean days and writes proposals to the log (dry run, prices do NOT change).
3. Review the log → if the proposals look sane → the "Auto" button on a product enables live application (the floor stays a hard bottom).
4. Control: the per-store or global kill switch halts everything instantly.

## Roadmap (future, beyond v1)
An LLM recommendation agent (the schema is already designed for it); competitor price monitoring; ads/boost as a **lever** (currently collected only); **analysis of promotion impact on sales** (we collect the flags but do not act on them yet); pooling of low-volume SKUs (hierarchical Bayes).
