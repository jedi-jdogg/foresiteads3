// Vista Social API with an API key. Vista Social's public API is documented at vistasocial.com/api;
// the paths below follow it and any mismatch surfaces as an HTTP error on the tool.
import { getJson } from './registry.js';

const BASE = 'https://vistasocial.com/api/v1';
const headers = (creds) => ({ Authorization: `Bearer ${creds.VISTASOCIAL_API_KEY}` });

export async function test(creds) {
  const json = await getJson(`${BASE}/profiles`, { headers: headers(creds) });
  const n = Array.isArray(json) ? json.length : json.data?.length ?? 0;
  return `Vista Social: ${n} connected profiles`;
}

export async function tools(creds) {
  const h = headers(creds);
  return [
    {
      name: 'profiles',
      description: 'Connected social profiles (network, name).',
      input_schema: { type: 'object', properties: {} },
      run: () => getJson(`${BASE}/profiles`, { headers: h }),
    },
    {
      name: 'upcoming_posts',
      description: 'Scheduled posts in the publishing queue.',
      input_schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } } },
      run: ({ limit = 25 }) => getJson(`${BASE}/posts?status=scheduled&limit=${limit}`, { headers: h }),
    },
    {
      name: 'recent_posts',
      description: 'Recently published posts with engagement where available.',
      input_schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } } },
      run: ({ limit = 25 }) => getJson(`${BASE}/posts?status=published&limit=${limit}`, { headers: h }),
    },
  ];
}
