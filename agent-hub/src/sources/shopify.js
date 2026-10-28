// Shopify Admin API (GraphQL), read-only. Needs a custom-app token with read_orders, read_all_orders,
// read_products, read_inventory, read_customers.
import { getJson, daysAgo, num } from './registry.js';

const VERSION = '2026-07';

function gql(creds) {
  const store = creds.SHOPIFY_STORE.replace(/\.myshopify\.com$/, '');
  const url = `https://${store}.myshopify.com/admin/api/${VERSION}/graphql.json`;
  return async (query, variables = {}) => {
    const json = await getJson(url, { method: 'POST', headers: { 'X-Shopify-Access-Token': creds.SHOPIFY_ADMIN_TOKEN }, body: { query, variables } });
    if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
    return json.data;
  };
}

async function allOrders(run, days, max = 2500) {
  const since = daysAgo(days);
  const orders = [];
  let after = null;
  do {
    const data = await run(`query($q:String!,$after:String){ orders(first:250, after:$after, query:$q, sortKey:CREATED_AT, reverse:true){
      pageInfo{ hasNextPage endCursor }
      nodes{ id name createdAt cancelledAt displayFinancialStatus
        currentTotalPriceSet{ shopMoney{ amount } } currentSubtotalPriceSet{ shopMoney{ amount } } totalDiscountsSet{ shopMoney{ amount } }
        customer{ id numberOfOrders } channelInformation{ channelDefinition{ channelName } }
        lineItems(first:50){ nodes{ title quantity sku product{ id title vendor productType } originalUnitPriceSet{ shopMoney{ amount } } } } } } }`,
      { q: `created_at:>=${since} status:any`, after });
    orders.push(...data.orders.nodes.filter((o) => !o.cancelledAt));
    after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (after && orders.length < max);
  return { orders, since, truncated: Boolean(after) };
}

export async function test(creds) {
  const run = gql(creds);
  const data = await run(`{ shop { name myshopifyDomain plan { displayName } currencyCode } }`);
  return `${data.shop.name} (${data.shop.myshopifyDomain}, ${data.shop.plan.displayName})`;
}

export async function tools(creds) {
  const run = gql(creds);
  return [
    {
      name: 'sales_summary',
      description: 'Sales for the last N days (default 30): order count, revenue, average order value, discounts, new vs returning customers, revenue by sales channel, and a comparison with the N days before.',
      input_schema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 365, description: 'Window length in days' } } },
      async run({ days = 30 }) {
        const cur = await allOrders(run, days);
        const prev = await allOrders(run, days * 2);
        const prevOnly = prev.orders.filter((o) => o.createdAt < cur.since + 'T00:00:00Z');
        const sum = (list) => {
          const rev = list.reduce((a, o) => a + Number(o.currentTotalPriceSet.shopMoney.amount), 0);
          const disc = list.reduce((a, o) => a + Number(o.totalDiscountsSet.shopMoney.amount), 0);
          const newCust = list.filter((o) => o.customer && Number(o.customer.numberOfOrders) <= 1).length;
          return { orders: list.length, revenue: num(rev), aov: list.length ? num(rev / list.length) : 0, discounts: num(disc), newCustomers: newCust, returningCustomers: list.filter((o) => o.customer && Number(o.customer.numberOfOrders) > 1).length };
        };
        const byChannel = {};
        for (const o of cur.orders) { const c = o.channelInformation?.channelDefinition?.channelName ?? 'Other'; byChannel[c] = num((byChannel[c] ?? 0) + Number(o.currentTotalPriceSet.shopMoney.amount)); }
        return { window: `${cur.since} to today`, current: sum(cur.orders), previous: { window: `${prev.since} to ${cur.since}`, ...sum(prevOnly) }, revenueByChannel: byChannel, note: cur.truncated ? 'Capped at 2500 orders; totals are partial.' : undefined };
      },
    },
    {
      name: 'top_products',
      description: 'Best-selling products over the last N days (default 30) by revenue, with units and vendor.',
      input_schema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 365 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
      async run({ days = 30, limit = 20 }) {
        const { orders, since } = await allOrders(run, days);
        const agg = new Map();
        for (const o of orders) for (const li of o.lineItems.nodes) {
          const k = li.product?.id ?? li.title;
          const r = agg.get(k) ?? { product: li.product?.title ?? li.title, vendor: li.product?.vendor, type: li.product?.productType, units: 0, revenue: 0 };
          r.units += li.quantity; r.revenue += li.quantity * Number(li.originalUnitPriceSet.shopMoney.amount); agg.set(k, r);
        }
        return { since, products: [...agg.values()].sort((a, b) => b.revenue - a.revenue).slice(0, limit).map((r) => ({ ...r, revenue: num(r.revenue) })) };
      },
    },
    {
      name: 'search_products',
      description: 'Find products by title, SKU, vendor or tag. Returns price, compare-at price, inventory and status.',
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Shopify product search, e.g. "batting" or "vendor:Hobbs"' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'] },
      async run({ query, limit = 10 }) {
        const data = await run(`query($q:String!,$n:Int!){ products(first:$n, query:$q){ nodes{ title handle vendor productType status totalInventory tags
          priceRangeV2{ minVariantPrice{ amount } maxVariantPrice{ amount } } variants(first:5){ nodes{ title sku price compareAtPrice inventoryQuantity } } } } }`, { q: query, n: limit });
        return data.products.nodes;
      },
    },
    {
      name: 'recent_orders',
      description: 'The most recent orders (default 10) with totals, status and line items.',
      input_schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } } },
      async run({ limit = 10 }) {
        const data = await run(`query($n:Int!){ orders(first:$n, sortKey:CREATED_AT, reverse:true){ nodes{ name createdAt displayFinancialStatus displayFulfillmentStatus
          currentTotalPriceSet{ shopMoney{ amount } } lineItems(first:10){ nodes{ title quantity } } } } }`, { n: limit });
        return data.orders.nodes.map((o) => ({ order: o.name, at: o.createdAt, total: num(o.currentTotalPriceSet.shopMoney.amount), payment: o.displayFinancialStatus, fulfillment: o.displayFulfillmentStatus, items: o.lineItems.nodes.map((l) => `${l.quantity}× ${l.title}`) }));
      },
    },
    {
      name: 'low_stock',
      description: 'Products whose total inventory is at or below a threshold (default 5), for restock decisions.',
      input_schema: { type: 'object', properties: { threshold: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
      async run({ threshold = 5, limit = 30 }) {
        const data = await run(`query($q:String!,$n:Int!){ products(first:$n, query:$q){ nodes{ title vendor totalInventory status } } }`, { q: `inventory_total:<=${threshold} status:active`, n: limit });
        return data.products.nodes;
      },
    },
  ];
}
