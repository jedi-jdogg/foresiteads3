// Klaviyo API, read-only, with a private API key.
import { getJson, daysAgo } from './registry.js';

const BASE = 'https://a.klaviyo.com/api';
const REVISION = '2025-07-15';
const headers = (creds) => ({ Authorization: `Klaviyo-API-Key ${creds.KLAVIYO_API_KEY}`, revision: REVISION });

export async function test(creds) {
  const json = await getJson(`${BASE}/accounts`, { headers: headers(creds) });
  const a = json.data?.[0]?.attributes;
  return a ? `${a.contact_information?.organization_name ?? 'Klaviyo account'} (${a.timezone ?? ''})` : 'Klaviyo account';
}

export async function tools(creds) {
  const h = headers(creds);
  return [
    {
      name: 'recent_campaigns',
      description: 'Email and SMS campaigns from the last N days (default 30): name, channel, status, send time and audiences.',
      input_schema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 365 }, channel: { type: 'string', enum: ['email', 'sms'] } } },
      async run({ days = 30, channel = 'email' }) {
        const filter = `and(equals(messages.channel,'${channel}'),greater-than(scheduled_at,${daysAgo(days)}T00:00:00Z))`;
        const json = await getJson(`${BASE}/campaigns?filter=${encodeURIComponent(filter)}&sort=-scheduled_at&fields[campaign]=name,status,send_time,scheduled_at,audiences`, { headers: h });
        return json.data.map((c) => ({ id: c.id, name: c.attributes.name, status: c.attributes.status, sendTime: c.attributes.send_time ?? c.attributes.scheduled_at, included: c.attributes.audiences?.included?.length ?? 0 }));
      },
    },
    {
      name: 'campaign_performance',
      description: 'Performance of recent campaigns: recipients, open rate, click rate, placed-order revenue. Uses Klaviyo\'s campaign values report for the last N days (default 30).',
      input_schema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 365 } } },
      async run({ days = 30 }) {
        const metrics = await getJson(`${BASE}/metrics?filter=${encodeURIComponent("equals(name,'Placed Order')")}`, { headers: h });
        const conversion = metrics.data?.[0]?.id;
        if (!conversion) throw new Error('No "Placed Order" metric found; is Shopify connected to Klaviyo?');
        const json = await getJson(`${BASE}/campaign-values-reports`, { method: 'POST', headers: h, body: { data: { type: 'campaign-values-report', attributes: {
          timeframe: { key: days <= 30 ? 'last_30_days' : days <= 90 ? 'last_90_days' : 'last_365_days' },
          conversion_metric_id: conversion,
          statistics: ['recipients', 'open_rate', 'click_rate', 'conversion_value', 'conversions', 'unsubscribe_rate'],
        } } } });
        return json.data?.attributes?.results?.map((r) => ({ campaignId: r.groupings?.campaign_id, ...r.statistics })) ?? [];
      },
    },
    {
      name: 'flows',
      description: 'All flows (automations) with status and trigger type.',
      input_schema: { type: 'object', properties: {} },
      async run() {
        const json = await getJson(`${BASE}/flows?fields[flow]=name,status,trigger_type,updated`, { headers: h });
        return json.data.map((f) => ({ id: f.id, name: f.attributes.name, status: f.attributes.status, trigger: f.attributes.trigger_type, updated: f.attributes.updated }));
      },
    },
    {
      name: 'lists',
      description: 'Lists and segments with profile counts.',
      input_schema: { type: 'object', properties: {} },
      async run() {
        const [lists, segments] = await Promise.all([
          getJson(`${BASE}/lists?additional-fields[list]=profile_count&fields[list]=name,profile_count`, { headers: h }),
          getJson(`${BASE}/segments?additional-fields[segment]=profile_count&fields[segment]=name,profile_count`, { headers: h }),
        ]);
        return { lists: lists.data.map((l) => ({ name: l.attributes.name, profiles: l.attributes.profile_count })), segments: segments.data.map((s) => ({ name: s.attributes.name, profiles: s.attributes.profile_count })) };
      },
    },
  ];
}
