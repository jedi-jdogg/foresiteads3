# Snapshot directory

`pricing-bot analyze --snapshot ./data` reads a snapshot of Shopify data from here.
Files are produced either by `pricing-bot fetch` (live Admin API) or by saving the
raw output of the Shopify MCP tools in Claude Code. Expected files:

| File | Source | Shape |
|------|--------|-------|
| `sales-365d.json` | ShopifyQL `FROM sales ... GROUP BY product_id, product_title SINCE -365d` | `{columns, rows}` |
| `sales-YYYY-MM.json` | ShopifyQL `FROM sales ... GROUP BY product_id SINCE <first> UNTIL <last>` (one per month) | `{columns, rows}` |
| `inventory-90d.json` | ShopifyQL `FROM inventory SHOW ... sell_through_rate GROUP BY product_title SINCE -90d` | `{columns, rows}` |
| `products-*.json` | Admin GraphQL `nodes(ids:[...]) { ... on Product { ... variants ... inventoryItem { unitCost } } }` | `{data:{nodes:[...]}}` |

Raw JSON snapshots are git-ignored because they contain unit costs.
