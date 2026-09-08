---
name: pricing-super-bot
description: Refresh the lindas.com pricing headroom report — which products can take a price increase without losing demand. Use when Jonathan asks to re-run the pricing bot, find price increase opportunities, check pricing headroom, or update the pricing report for Linda's.
---

# Pricing super bot (lindas.com)

Code lives in `pricing-super-bot/`. Read its `README.md` for the scoring model. The bot is
offline-first: it scores a snapshot of Shopify data in `pricing-super-bot/data/`.

## Refresh the snapshot with the Shopify MCP tools

1. Confirm the connected store is `lindas.com` with `get-shop-info`.
2. Run these ShopifyQL queries with `run-analytics-query` and save each raw JSON result verbatim into
   `pricing-super-bot/data/` (large results are written to a tool-results file; copy that file):
   - `sales-365d.json`: `FROM sales SHOW net_items_sold, gross_sales, discounts, net_sales, orders GROUP BY product_id, product_title SINCE -365d UNTIL today ORDER BY net_sales DESC LIMIT 250`
   - `sales-YYYY-MM.json`, one per complete month in the last 12: `FROM sales SHOW net_items_sold, gross_sales, discounts, net_sales, orders GROUP BY product_id SINCE YYYY-MM-01 UNTIL YYYY-MM-<last day> ORDER BY net_sales DESC LIMIT 300` (do not use TIMESERIES; it truncates to one bucket)
   - `inventory-90d.json`: `FROM inventory SHOW starting_inventory_units, ending_inventory_units, inventory_units_sold, sell_through_rate GROUP BY product_title SINCE -90d UNTIL today ORDER BY inventory_units_sold DESC LIMIT 300`
3. Fetch the catalog for every product_id in `sales-365d.json` with `graphql_query`, 50 ids per call,
   saving each response as `products-N.json`. Use the query in `pricing-super-bot/src/shopify.js`
   (`PRODUCT_NODES_QUERY`).
4. Inline tool results are also stored in the session transcript; a small node script can extract
   them by matching the `query` field.

## Analyse and deliver

```bash
cd pricing-super-bot && npm test && node bin/pricing-bot.js analyze --snapshot ./data --out ./reports --name $(date +%F)
```

Publish `reports/<date>-lindas-pricing.html` as an artifact and send the CSV. Lead the summary with
the "Raise now" list and the estimated annual profit change. Never change prices in Shopify from
this skill; the CSV is for review.
