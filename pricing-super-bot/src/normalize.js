import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const num = (v) => (v === '' || v == null ? 0 : Number(v));

export function tableToObjects(table) {
  const cols = table.columns.map((c) => c.name);
  return table.rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}

export function gidToId(gid) {
  return String(gid).split('/').pop();
}

export async function loadSnapshot(dir) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  const read = async (f) => JSON.parse(await readFile(join(dir, f), 'utf8'));

  const snapshot = { products: new Map(), sales365: [], monthly: new Map(), inventory: new Map(), months: [] };

  for (const f of files) {
    if (/^products-.*\.json$/.test(f)) {
      const json = await read(f);
      for (const node of json.data?.nodes ?? []) {
        if (!node) continue;
        snapshot.products.set(gidToId(node.id), normalizeProduct(node));
      }
    } else if (f === 'sales-365d.json') {
      snapshot.sales365 = tableToObjects(await read(f)).map(normalizeSalesRow);
    } else if (/^sales-\d{4}-\d{2}\.json$/.test(f)) {
      const key = f.slice(6, 13);
      snapshot.monthly.set(key, tableToObjects(await read(f)).map(normalizeSalesRow));
    } else if (f === 'inventory-90d.json') {
      for (const r of tableToObjects(await read(f))) {
        snapshot.inventory.set(r.product_title, {
          starting: num(r.starting_inventory_units),
          ending: num(r.ending_inventory_units),
          sold: num(r.inventory_units_sold),
          sellThrough: num(r.sell_through_rate),
        });
      }
    }
  }
  snapshot.months = [...snapshot.monthly.keys()].sort();
  return snapshot;
}

export function normalizeSalesRow(r) {
  return {
    productId: r.product_id ?? '',
    title: r.product_title ?? '',
    units: num(r.net_items_sold),
    gross: num(r.gross_sales),
    discounts: Math.abs(num(r.discounts)),
    net: num(r.net_sales),
    orders: num(r.orders),
  };
}

export function normalizeProduct(node) {
  const variants = (node.variants?.edges ?? []).map(({ node: v }) => ({
    id: gidToId(v.id),
    title: v.title,
    sku: v.sku,
    price: num(v.price),
    compareAtPrice: v.compareAtPrice == null ? null : num(v.compareAtPrice),
    inventoryQuantity: v.inventoryQuantity ?? 0,
    tracked: Boolean(v.inventoryItem?.tracked),
    unitCost: v.inventoryItem?.unitCost?.amount == null ? null : num(v.inventoryItem.unitCost.amount),
  }));
  return {
    id: gidToId(node.id),
    title: node.title,
    handle: node.handle,
    vendor: node.vendor,
    productType: node.productType,
    tags: node.tags ?? [],
    status: node.status,
    totalInventory: node.totalInventory ?? 0,
    createdAt: node.createdAt,
    variants,
  };
}
