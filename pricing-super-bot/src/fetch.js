import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ShopifyClient } from './shopify.js';

const SALES_COLS = 'net_items_sold, gross_sales, discounts, net_sales, orders';

export function monthWindows(asOf = new Date(), months = 12) {
  // Last `months` complete calendar months before the month containing asOf.
  const out = [];
  const y = asOf.getUTCFullYear();
  const m = asOf.getUTCMonth();
  for (let i = months; i >= 1; i--) {
    const start = new Date(Date.UTC(y, m - i, 1));
    const end = new Date(Date.UTC(y, m - i + 1, 0));
    const iso = (d) => d.toISOString().slice(0, 10);
    out.push({ key: iso(start).slice(0, 7), since: iso(start), until: iso(end) });
  }
  return out;
}

export async function fetchSnapshot({ outDir, store, token, version, top = 250, months = 12, log = console.error }) {
  const client = new ShopifyClient({ store, token, version });
  await mkdir(outDir, { recursive: true });
  const save = (name, obj) => writeFile(join(outDir, name), JSON.stringify(obj));

  log(`→ 365-day sales by product (top ${top})`);
  const sales = await client.shopifyql(
    `FROM sales SHOW ${SALES_COLS} GROUP BY product_id, product_title SINCE -365d UNTIL today ORDER BY net_sales DESC LIMIT ${top}`,
  );
  await save('sales-365d.json', sales);

  for (const w of monthWindows(new Date(), months)) {
    log(`→ monthly sales ${w.key}`);
    const rows = await client.shopifyql(
      `FROM sales SHOW ${SALES_COLS} GROUP BY product_id SINCE ${w.since} UNTIL ${w.until} ORDER BY net_sales DESC LIMIT 300`,
    );
    await save(`sales-${w.key}.json`, rows);
  }

  log('→ 90-day inventory sell-through');
  const inv = await client.shopifyql(
    'FROM inventory SHOW starting_inventory_units, ending_inventory_units, inventory_units_sold, sell_through_rate GROUP BY product_title SINCE -90d UNTIL today ORDER BY inventory_units_sold DESC LIMIT 300',
  );
  await save('inventory-90d.json', inv);

  const idCol = sales.columns.findIndex((c) => c.name === 'product_id');
  const ids = sales.rows.map((r) => r[idCol]).filter((id) => id && id !== '0');
  log(`→ catalog for ${ids.length} products`);
  const nodes = await client.productsByIds(ids);
  await save('products-1.json', { data: { nodes } });
  log(`✓ snapshot written to ${outDir}`);
}
