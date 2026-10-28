// Meta Marketing API with a long-lived system-user token (ads_read).
import { getJson, daysAgo, today } from './registry.js';

const BASE = 'https://graph.facebook.com/v23.0';
const account = (creds) => `act_${String(creds.META_AD_ACCOUNT_ID).replace(/^act_/, '')}`;

export async function test(creds) {
  const json = await getJson(`${BASE}/${account(creds)}?fields=name,account_status,currency&access_token=${encodeURIComponent(creds.META_ADS_TOKEN)}`);
  return `${json.name} (${json.currency}, status ${json.account_status})`;
}

const FIELDS = 'spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,purchase_roas,actions,action_values';

function shape(row) {
  const act = (type) => Number(row.actions?.find((a) => a.action_type === type)?.value ?? 0);
  const val = (type) => Number(row.action_values?.find((a) => a.action_type === type)?.value ?? 0);
  return {
    name: row.campaign_name ?? row.adset_name ?? row.ad_name ?? 'account', spend: Number(row.spend), impressions: Number(row.impressions), clicks: Number(row.clicks),
    ctr: Number(row.ctr), cpc: Number(row.cpc), cpm: Number(row.cpm), reach: Number(row.reach), frequency: Number(row.frequency),
    purchases: act('purchase') || act('omni_purchase'), purchaseValue: val('purchase') || val('omni_purchase'),
    roas: Number(row.purchase_roas?.[0]?.value ?? 0), addToCart: act('add_to_cart') || act('omni_add_to_cart'),
  };
}

export async function tools(creds) {
  const token = encodeURIComponent(creds.META_ADS_TOKEN);
  const act = account(creds);
  return [
    {
      name: 'insights',
      description: 'Ad account performance for the last N days (default 30): spend, impressions, clicks, CTR, CPM, purchases, purchase value and ROAS. Set level to campaign for a per-campaign breakdown.',
      input_schema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 365 }, level: { type: 'string', enum: ['account', 'campaign', 'adset'] } } },
      async run({ days = 30, level = 'account' }) {
        const range = encodeURIComponent(JSON.stringify({ since: daysAgo(days), until: today() }));
        const json = await getJson(`${BASE}/${act}/insights?level=${level}&fields=${FIELDS}${level !== 'account' ? `,${level}_name` : ''}&time_range=${range}&limit=100&access_token=${token}`);
        const rows = json.data.map(shape).sort((a, b) => b.spend - a.spend);
        return { window: `${daysAgo(days)} to ${today()}`, level, rows };
      },
    },
    {
      name: 'active_campaigns',
      description: 'Campaigns with status, objective, daily/lifetime budget.',
      input_schema: { type: 'object', properties: { status: { type: 'string', enum: ['ACTIVE', 'PAUSED', 'ALL'] } } },
      async run({ status = 'ACTIVE' }) {
        const filter = status === 'ALL' ? '' : `&effective_status=${encodeURIComponent(JSON.stringify([status]))}`;
        const json = await getJson(`${BASE}/${act}/campaigns?fields=name,objective,status,effective_status,daily_budget,lifetime_budget,start_time${filter}&limit=100&access_token=${token}`);
        return json.data.map((c) => ({ ...c, daily_budget: c.daily_budget ? Number(c.daily_budget) / 100 : undefined, lifetime_budget: c.lifetime_budget ? Number(c.lifetime_budget) / 100 : undefined }));
      },
    },
  ];
}
