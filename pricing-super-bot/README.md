# Linda's Pricing Super Bot

Finds products on **lindas.com** (Linda's Electric Quilters, Shopify Plus) where the price can be
raised with little or no impact on demand, and says by how much.

It does not change prices. It produces a ranked report and a CSV you can review and load through
Shopify's bulk editor.

## How it decides

For every revenue-leading product it pulls 12 months of Shopify sales, the monthly series, 90-day
inventory sell-through and the live catalog (price, compare-at, unit cost, tags). Seven signals are
each scored 0–1, where 1 means "demand is unlikely to react to a price increase":

| Signal | Weight | What it reads |
|---|---|---|
| Price tolerance | 25% | Realised price (net ÷ units) second half vs first half of the window. A 5%+ move gives an observed elasticity from the units response. |
| Discount dependence | 20% | Discounts as a share of gross sales. ≤2% scores 1, ≥15% scores 0. |
| Trend | 15% | Second-half vs first-half monthly units. |
| Stability | 10% | Month-to-month coefficient of variation of units. |
| Strike-through headroom | 10% | Gap between price and compare-at price. Raising while staying under it keeps the sale framing. |
| Scarcity | 10% | Pre-order items, tracked stock at zero while still selling, 90-day sell-through ≥70%. Overstock scores low. |
| Competition | 10% | Private label scores 1. MAP-priced brands and drop-shipped SKUs score low because the same item is sold elsewhere at the same price. |

The weighted score maps to a tier and a default move:

| Tier | Score | Move | Impact assumption |
|---|---|---|---|
| Raise now | ≥ 0.70 | +8% | units fall 0.5 × price change |
| Raise | ≥ 0.60 | +5% | units fall 0.8 × price change |
| Test | ≥ 0.50 | +3% | units fall 1.0 × price change |
| Hold | < 0.50 | 0 | — |

Guardrails after tiering: thin history steps a product down one tier; MAP-priced brands are capped at
+3%; non-private-label drop-ship SKUs at +5%; a product whose demand fell more than 30% across the
window, or which is overstocked, is held regardless of score. New prices are rounded to end in 9 and
kept at least 5% under the compare-at price.

## Run it

```bash
cd pricing-super-bot
npm test                                   # unit tests for the scoring model

# Offline: analyse a snapshot already in ./data (see data/README.md for the file shapes)
node bin/pricing-bot.js analyze --snapshot ./data --out ./reports --name 2026-09-08

# Live: pull a fresh snapshot from the Admin API, then analyse
cp .env.example .env   # fill in SHOPIFY_STORE and SHOPIFY_ADMIN_TOKEN
set -a; . ./.env; set +a
node bin/pricing-bot.js fetch --out ./data
node bin/pricing-bot.js analyze
```

`fetch` needs a custom-app token with `read_products`, `read_inventory`, `read_orders` and
`read_reports` (ShopifyQL). The live path has been written against the Admin API but was validated
here only through the offline snapshot; if `shopifyqlQuery` is not enabled on the store, save the
Shopify MCP tool output into `./data` instead, as described in `data/README.md`.

## Output

`reports/<name>-lindas-pricing.html` is the dashboard; `.csv` has one row per variant with current
and recommended price, tier, score, signals and flags; `.json` is the full scored dataset.

## Caveats

- Monthly history is each month's top 300 products by net sales, so a missing month means "not in
  the top 300", not zero. Confidence (high / medium / low) reflects months seen and units sold.
- Realised price is influenced by discount depth and variant mix, not just list price. Treat an
  elasticity read as evidence, not proof.
- Roll and by-the-yard versions of the same batting are scored separately. Raise them together so the
  per-yard math still favours the roll.
- Impact figures are the next 12 months at current demand. Profit uses the unit cost recorded on the
  Shopify variant where present.
