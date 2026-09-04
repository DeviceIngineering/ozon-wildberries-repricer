# How a price is decided

This document answers the question "why did the program set that particular price". It is written for someone who runs stores, not for someone reading the code. The technical description of the experiment engine is in [strategies.md](strategies.md); how the system is put together is in [architecture.md](architecture.md).

---

## In short

A price is determined by four numbers. Three of them you supply; the fourth the system works out itself.

| Number | Who sets it | What it means |
|---|---|---|
| **Cost price** (`cost_price`) | you | What the product cost you. Without it there is no protection — the program has nothing to measure a loss against |
| **Reference price** (`ref_price`) | you | The price that should be held. The repricer pulls the price back to it whenever the marketplace moves it |
| **Corridor bounds** | you, optional | The minimum and maximum for a price experiment |
| **Price floor** (`floor_min_price`) | **the system** | Computed break-even: below this price the product sells at a loss |

One rule always holds: **the floor beats the reference price**. If your reference price turns out to be below the floor, the program will not sell at a loss — it raises the case in the cockpit as a "reference price below cost" task and skips the product.

---

## The price floor: where the number comes from

The floor is the price at which you break even once everything the marketplace withholds is accounted for, plus your target margin. It is computed **separately for each marketplace**, because their economics differ. This is not pedantry: one universal formula for all of them is off by tens of percent.

### Ozon

```
floor = (cost × (1 + margin%) / (1 − tax%) + logistics + acquiring) / (1 − commission%)
```

Commission, logistics and acquiring are not invented — they come from Ozon's live per-product response, so they move with the category and the warehouse. The tax here is nested: it is charged on what remains after the deductions.

### Yandex Market

Here the tax is charged on **gross** revenue — on the full amount the buyer paid, not on what is left over. This is not a detail: the old formula, shared with Ozon, understated the floor and was the cause of real losses.

On top of that, the **actual boost rate** goes into the denominator. Yandex does not publish it in any tariff reference, so it is reconstructed from the last 7 days of order statistics: only products that were genuinely promoted and have accumulated a large enough sample are counted. The rate is capped from above by a ceiling in the store settings.

If the sum of all percentage deductions approaches 95%, the program treats the data as anomalous and sets no floor — better to leave the price alone than to inflate it by mistake.

### Wildberries

```
FBO commission for the product category + logistics by box volume
+ return logistics × buyout-failure rate
```

One subtlety of its own: **a tax rate of zero means zero percent, not "not set"**. If you are on a patent or self-employment regime, the protection keeps working. On Ozon this case used to silently disable the floor; that has been fixed.

---

## The order in which a decision is made

Every repricer run walks this ladder for every product. The first condition that fires is final.

1. **Product in `disposal` mode** → the price is frozen, leave it alone.
2. **Product in a price experiment** → the strategy engine sets the price; the repricer does not interfere.
3. **No cost price** → there is no floor. The product shows up in the cockpit as "cost price missing". The reference price is still held, but there is no loss protection.
4. **Reference price below cost** → skip and report. This is bad data, not a reason to sell at a loss.
5. **Product in a promotion** → a promotional price cannot be raised through the ordinary mechanism. If the promo price is below cost, a task goes to the cockpit and, if automatic exit is enabled, the product is pulled out of the promotion.
6. **Product in quarantine** (Wildberries) → the marketplace is not applying the price; wait for confirmation in the seller account.
7. **Price below the floor** → raise it to the floor.
8. **Price has drifted from the reference price** by more than the threshold → pull it back to the reference price.
9. Otherwise → do nothing, log `ok`.

The deviation thresholds (separate ones for a drop and for a rise) are set in the store settings. The point is not to jerk the price around over a few kopecks of discrepancy.

---

## What happens with promotions

The marketplace adds products to discounts on its own, and that is the single biggest source of quietly lost margin. The program deals with it on three levels:

- **Self-ban.** On Ozon a flag is set that forbids products from being added to promotions automatically. That treats the cause, not the symptom.
- **Allowlist.** You mark the promotions you actually want to take part in. Products are pulled out of the rest.
- **Discount depth limit.** Even an approved promotion must not push the price below a given percentage.

The exit works from the live list of promotions on the marketplace, not from a local copy that may be stale. Frozen promotions are skipped. If one pass cannot remove everything, the next run picks up the remainder.

Wildberries has no "exit promotion" endpoint, so the exit is performed by restoring the base-price-plus-discount pair through the Prices API.

---

## The master price: one price across three marketplaces

When the same article number is listed on several marketplaces, it is easier to set one price for the buyer than three. The master price expands it into each marketplace's own rules:

- **Ozon** — `price`, `old_price` and `min_price`, subject to the platform's constraints: the minimum price must be at least 50% of the price, and the struck-through price must exceed the price and be at least twice the minimum.
- **Wildberries** — a base-price-plus-discount pair, because you cannot set the buyer's price directly there. The program picks the discount that produces the price you asked for.
- **Yandex Market** — `price` plus `discountBase`, where the discount has to fall inside the permitted 5–99% corridor, otherwise Market removes the struck-through price.

A "before → after" preview is always shown before anything is sent, marking which positions were skipped and why. The write goes out as a single batch per store so as not to hit rate limits, and a snapshot for rollback is taken beforehand.

---

## When the price is found by experiment

Everything above is rules: "hold the reference price", "never go below the floor". But the right reference price is not known in the first place. A price experiment is a way of finding it from actual sales.

It is enabled **not for every product**, but for the ones you choose, and by default it runs in suggestion mode: the engine logs the price it would set and why, but changes nothing until you switch a specific product to Auto.

How it searches:

1. **Corridor scan.** It sets 4 prices on a grid from the minimum to the maximum and looks at where sales are better. This is a coarse survey — its job is to keep the search from getting stuck next to the starting price.
2. **Ladder search.** From the best point it moves in 8% steps, evaluating the result each time.
3. **Hold.** The price is held until 12 sales and at least 3 days have accumulated. Without that, a demand estimate means nothing.
4. **Reverse and refine.** Worse than before → step the other way. Worse twice → back to the best price, and the step size is halved.

The decision is not made on the average number of sales but on the **lower bound** of demand: while data is scarce, the engine assumes the pessimistic case and does not grab at a price that merely happens to look good across three sales.

Days spoiled by outside causes — the product ran out, a promotion was running, there was an advertising spike, the loyalty discount changed — are flagged and excluded from the estimate.

The price floor remains a hard boundary here too: an experiment cannot drive the price into a loss.

Five kinds of strategy:

| Strategy | What it maximises |
|---|---|
| `ref_price` | Searches for nothing — just holds the reference price. The default |
| `max_profit` | Profit per day |
| `max_revenue` | Revenue per day |
| `max_units` | Units sold, subject to the target margin |
| `liquidation` | Sell-through speed. The only mode allowed to go below cost price — by a depth you specify |

---

## How to check what the program did

- **Repricer log** — the decision for every product on every run: old price, new price, reference price, deviation, action and reason.
- **Strategy decision log** — what the experiment engine proposed and why, including proposals that were never applied.
- **Cockpit** — tasks sorted by the money at risk.
- **Price snapshots** — the state before every mass write, with rollback available.
- **Application check.** Three minutes after a write, the price is read back from the marketplace. If the marketplace reported success but did not set the price, the write is flagged `VERIFIED_FAIL`. This happens more often than you would think.

---

## What the program does not do

An honest list, so that nobody builds up the wrong expectations:

- **It does not track competitors' prices.** There is no storefront scraping here — that is against Ozon's rules, and the consequences would land on your seller account. The price is computed from your economics, not from someone else's.
- **It does not check your cost price.** A wrong cost price yields a confidently computed wrong floor, and the system has no way to detect it.
- **It does not manage advertising automatically.** Advertising spend is collected and counted in the P&L, and there are tools for switching campaigns off, but it does not manage bids itself.
- **It does not handle VAT.** The model assumes a simplified tax regime.

---

**Next:** [user guide](user-guide.md) · [inside the strategy engine](strategies.md) · [architecture](architecture.md) · [installation](installation.md)
