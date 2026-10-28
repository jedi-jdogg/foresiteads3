// Google: one OAuth sign-in covers Analytics (GA4), Google Ads, Merchant Center and Business Profile.
// The hub runs the consent flow on localhost and keeps the refresh token in .env (GOOGLE_REFRESH_TOKEN).
import { getJson, daysAgo, today } from './registry.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/adwords',
  'https://www.googleapis.com/auth/content',
  'https://www.googleapis.com/auth/business.manage',
];

export function authUrl(creds, redirectUri, state) {
  const p = new URLSearchParams({ client_id: creds.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function exchangeCode(creds, code, redirectUri) {
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: creds.GOOGLE_CLIENT_ID, client_secret: creds.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: 'authorization_code' }) });
  const json = await res.json();
  if (!json.refresh_token) throw new Error(json.error_description ?? json.error ?? 'Google did not return a refresh token.');
  return json.refresh_token;
}

const tokens = new Map();
async function accessToken(creds) {
  const cached = tokens.get(creds.GOOGLE_REFRESH_TOKEN);
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: creds.GOOGLE_REFRESH_TOKEN, client_id: creds.GOOGLE_CLIENT_ID, client_secret: creds.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token' }) });
  const json = await res.json();
  if (!json.access_token) throw new Error(`Google sign-in expired (${json.error ?? 'no token'}). Connect again.`);
  tokens.set(creds.GOOGLE_REFRESH_TOKEN, { token: json.access_token, exp: Date.now() + json.expires_in * 1000 });
  return json.access_token;
}
const auth = async (creds) => ({ Authorization: `Bearer ${await accessToken(creds)}` });

export async function test(creds) {
  const h = await auth(creds);
  const json = await getJson(`https://analyticsadmin.googleapis.com/v1beta/properties/${creds.GA4_PROPERTY_ID}`, { headers: h });
  return `Google signed in. GA4: ${json.displayName}`;
}

export async function tools(creds) {
  const out = [
    {
      name: 'ga4_overview',
      description: 'GA4 traffic for the last N days (default 30): sessions, users, conversions, revenue, by default channel group, compared with the previous period.',
      input_schema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 365 } } },
      async run({ days = 30 }) {
        const h = await auth(creds);
        const body = { dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }, { startDate: `${days * 2}daysAgo`, endDate: `${days + 1}daysAgo` }],
          dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'ecommercePurchases' }, { name: 'purchaseRevenue' }, { name: 'sessionConversionRate' }] };
        const json = await getJson(`https://analyticsdata.googleapis.com/v1beta/properties/${creds.GA4_PROPERTY_ID}:runReport`, { method: 'POST', headers: h, body });
        const rows = (json.rows ?? []).map((r) => ({ channel: r.dimensionValues[0].value, period: r.dimensionValues[1]?.value ?? 'date_range_0', sessions: +r.metricValues[0].value, users: +r.metricValues[1].value, purchases: +r.metricValues[2].value, revenue: +r.metricValues[3].value, conversionRate: +r.metricValues[4].value }));
        return { current: rows.filter((r) => r.period === 'date_range_0'), previous: rows.filter((r) => r.period === 'date_range_1') };
      },
    },
    {
      name: 'ga4_top_pages',
      description: 'Most viewed landing pages in GA4 for the last N days (default 30) with sessions and purchase revenue.',
      input_schema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 365 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
      async run({ days = 30, limit = 20 }) {
        const h = await auth(creds);
        const body = { dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }], dimensions: [{ name: 'landingPagePlusQueryString' }], metrics: [{ name: 'sessions' }, { name: 'purchaseRevenue' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit };
        const json = await getJson(`https://analyticsdata.googleapis.com/v1beta/properties/${creds.GA4_PROPERTY_ID}:runReport`, { method: 'POST', headers: h, body });
        return (json.rows ?? []).map((r) => ({ page: r.dimensionValues[0].value, sessions: +r.metricValues[0].value, revenue: +r.metricValues[1].value }));
      },
    },
  ];
  if (creds.GOOGLE_ADS_CUSTOMER_ID && creds.GOOGLE_ADS_DEVELOPER_TOKEN) {
    out.push({
      name: 'ads_campaigns',
      description: 'Google Ads campaign performance for the last N days (default 30): cost, clicks, impressions, conversions, conversion value.',
      input_schema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 365 } } },
      async run({ days = 30 }) {
        const h = { ...(await auth(creds)), 'developer-token': creds.GOOGLE_ADS_DEVELOPER_TOKEN };
        const cid = creds.GOOGLE_ADS_CUSTOMER_ID.replace(/-/g, '');
        const query = `SELECT campaign.name, campaign.status, campaign.advertising_channel_type, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${daysAgo(days)}' AND '${today()}' AND campaign.status != 'REMOVED' ORDER BY metrics.cost_micros DESC`;
        const json = await getJson(`https://googleads.googleapis.com/v20/customers/${cid}/googleAds:search`, { method: 'POST', headers: h, body: { query } });
        return (json.results ?? []).map((r) => ({ campaign: r.campaign.name, status: r.campaign.status, type: r.campaign.advertisingChannelType, cost: Number(r.metrics.costMicros) / 1e6, clicks: +r.metrics.clicks, impressions: +r.metrics.impressions, conversions: +r.metrics.conversions, conversionValue: +r.metrics.conversionsValue }));
      },
    });
  }
  if (creds.MERCHANT_CENTER_ID) {
    out.push({
      name: 'merchant_product_status',
      description: 'Merchant Center product approval summary: how many products are approved, pending or disapproved, and the most common issues.',
      input_schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 250 } } },
      async run({ limit = 250 }) {
        const h = await auth(creds);
        const json = await getJson(`https://shoppingcontent.googleapis.com/content/v2.1/${creds.MERCHANT_CENTER_ID}/productstatuses?maxResults=${limit}`, { headers: h });
        const tally = { approved: 0, pending: 0, disapproved: 0 }; const issues = {};
        for (const p of json.resources ?? []) {
          const st = p.destinationStatuses?.find((d) => d.destination === 'Shopping')?.status ?? 'pending';
          tally[st] = (tally[st] ?? 0) + 1;
          for (const i of p.itemLevelIssues ?? []) issues[i.description] = (issues[i.description] ?? 0) + 1;
        }
        return { sampled: json.resources?.length ?? 0, ...tally, topIssues: Object.entries(issues).sort((a, b) => b[1] - a[1]).slice(0, 10) };
      },
    });
  }
  out.push({
    name: 'business_profile_reviews',
    description: 'Recent Google Business Profile reviews (rating, text, reply status) for the first location on the account.',
    input_schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } } },
    async run({ limit = 20 }) {
      const h = await auth(creds);
      const accounts = await getJson('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', { headers: h });
      const acct = accounts.accounts?.[0]?.name;
      if (!acct) throw new Error('No Business Profile account on this Google login.');
      const locs = await getJson(`https://mybusinessbusinessinformation.googleapis.com/v1/${acct}/locations?readMask=name,title`, { headers: h });
      const loc = locs.locations?.[0];
      if (!loc) throw new Error('No locations on this Business Profile account.');
      const reviews = await getJson(`https://mybusiness.googleapis.com/v4/${acct}/${loc.name}/reviews?pageSize=${limit}`, { headers: h });
      return { location: loc.title, averageRating: reviews.averageRating, total: reviews.totalReviewCount, reviews: (reviews.reviews ?? []).map((r) => ({ rating: r.starRating, when: r.createTime, text: r.comment, replied: Boolean(r.reviewReply) })) };
    },
  });
  return out;
}
