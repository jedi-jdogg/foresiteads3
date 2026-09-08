// Thin Shopify Admin API client: GraphQL + ShopifyQL (via the shopifyqlQuery field).
// Only used by `pricing-bot fetch`. `analyze` works from a snapshot and needs no credentials.

export class ShopifyClient {
  constructor({ store, token, version = '2026-07', fetchImpl = globalThis.fetch } = {}) {
    if (!store || !token) throw new Error('SHOPIFY_STORE and SHOPIFY_ADMIN_TOKEN are required');
    this.store = store.replace(/\.myshopify\.com$/, '');
    this.token = token;
    this.version = version;
    this.fetch = fetchImpl;
    this.endpoint = `https://${this.store}.myshopify.com/admin/api/${version}/graphql.json`;
  }

  async graphql(query, variables = {}, { retries = 4 } = {}) {
    let attempt = 0;
    for (;;) {
      const res = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': this.token },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt++ >= retries) throw new Error(`Shopify HTTP ${res.status} after ${retries} retries`);
        const wait = Number(res.headers.get('retry-after')) * 1000 || 2 ** attempt * 500;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const json = await res.json();
      if (json.errors?.length) {
        const throttled = json.errors.some((e) => e.extensions?.code === 'THROTTLED');
        if (throttled && attempt++ < retries) {
          await new Promise((r) => setTimeout(r, 2 ** attempt * 500));
          continue;
        }
        throw new Error('GraphQL error: ' + JSON.stringify(json.errors));
      }
      return json.data;
    }
  }

  // Runs a ShopifyQL statement and returns the same {columns, rows} shape the MCP tool emits.
  async shopifyql(statement) {
    const data = await this.graphql(
      `query($q: String!) {
        shopifyqlQuery(query: $q) {
          __typename
          ... on TableResponse { tableData { columns { name dataType } rowData } }
          parseErrors { code message }
        }
      }`,
      { q: statement },
    );
    const r = data.shopifyqlQuery;
    if (r.parseErrors?.length) throw new Error('ShopifyQL: ' + r.parseErrors.map((e) => e.message).join('; '));
    if (!r.tableData) throw new Error('ShopifyQL returned no table for: ' + statement);
    return { query: statement, columns: r.tableData.columns, rows: r.tableData.rowData, rowCount: r.tableData.rowData.length };
  }

  async productsByIds(ids) {
    const gids = ids.map((id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/Product/${id}`));
    const out = [];
    for (let i = 0; i < gids.length; i += 50) {
      const data = await this.graphql(PRODUCT_NODES_QUERY, { ids: gids.slice(i, i + 50) });
      out.push(...data.nodes.filter(Boolean));
    }
    return out;
  }
}

export const PRODUCT_NODES_QUERY = `query($ids:[ID!]!){ nodes(ids:$ids){ ... on Product {
  id title handle vendor productType tags status totalInventory createdAt
  variants(first:50){ edges{ node{ id title sku price compareAtPrice inventoryQuantity inventoryPolicy
    inventoryItem{ tracked unitCost{ amount } } } } } } } }`;
