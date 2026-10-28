// Triple Whale API with an API key. Endpoint shapes follow Triple Whale's public API docs
// (developers.triplewhale.com); if one changes, the tool reports the HTTP error so it can be corrected.
import { getJson, daysAgo, today } from './registry.js';

const BASE = 'https://api.triplewhale.com/api/v2';
const headers = (creds) => ({ 'x-api-key': creds.TRIPLEWHALE_API_KEY });

export async function test(creds) {
  await getJson(`${BASE}/summary-page/get-data`, { method: 'POST', headers: headers(creds), body: { shopDomain: creds.TRIPLEWHALE_SHOP, period: { startDate: daysAgo(1), endDate: today() }, todayHour: null } });
  return `Triple Whale for ${creds.TRIPLEWHALE_SHOP}`;
}

export async function tools(creds) {
  const h = headers(creds);
  const shop = creds.TRIPLEWHALE_SHOP;
  return [
    {
      name: 'summary',
      description: 'Blended summary for the last N days (default 30): revenue, orders, total ad spend, blended ROAS/MER, new-customer ROAS, and spend by channel as Triple Whale reports it.',
      input_schema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 365 } } },
      async run({ days = 30 }) {
        const json = await getJson(`${BASE}/summary-page/get-data`, { method: 'POST', headers: h, body: { shopDomain: shop, period: { startDate: daysAgo(days), endDate: today() }, todayHour: null } });
        return { window: `${daysAgo(days)} to ${today()}`, ...json };
      },
    },
    {
      name: 'attribution',
      description: 'Attributed orders and revenue by channel/campaign for the last N days (default 30), using the Triple Pixel model.',
      input_schema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 180 }, model: { type: 'string', description: 'Attribution model, e.g. lastPlatformClick, linear, firstClick' } } },
      async run({ days = 30, model = 'lastPlatformClick' }) {
        const json = await getJson(`${BASE}/attribution/get-orders-with-attribution`, { method: 'POST', headers: h, body: { shop, model, startDate: daysAgo(days), endDate: today(), limit: 200 } });
        return json;
      },
    },
  ];
}
