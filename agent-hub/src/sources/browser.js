// A browser the agents can drive on the hub Mac: open pages, read them, click, type, screenshot.
// Built on Playwright with a persistent profile (logs/browser-profile) so sign-ins survive restarts.
// Playwright is installed on demand from the Connect tab; until then the tools explain how.
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PROFILE = new URL('../../logs/browser-profile/', import.meta.url);
const SHOTS = new URL('../../logs/images/', import.meta.url);
let ctx = null, page = null;

// Local install first (what the Connect tab's Install does), then a global one (NODE_PATH / npm -g).
async function playwright() {
  try { return await import('playwright'); } catch {}
  try { return createRequire(import.meta.url)('playwright'); } catch {}
  throw new Error('The browser is not installed yet. Connect tab → Browser → Install (about 150 MB, one time).');
}

export async function available() { try { await playwright(); return true; } catch { return false; } }

async function current() {
  const { chromium } = await playwright();
  if (!ctx) {
    await mkdir(PROFILE, { recursive: true });
    ctx = await chromium.launchPersistentContext(fileURLToPath(PROFILE), { headless: process.env.BROWSER_HEADLESS !== '0', viewport: { width: 1280, height: 860 }, args: ['--no-sandbox'] });
    ctx.on('close', () => { ctx = null; page = null; });
  }
  if (!page || page.isClosed()) page = ctx.pages()[0] ?? await ctx.newPage();
  return page;
}

async function summary(p) {
  const title = await p.title().catch(() => '');
  const text = await p.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  return { url: p.url(), title, text: text.replace(/\n{3,}/g, '\n\n').slice(0, 6000) };
}

const target = (p, { selector, text }) => text ? p.getByText(text, { exact: false }).first() : p.locator(selector).first();

export async function close() { await ctx?.close().catch(() => {}); ctx = null; page = null; }
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { close().finally(() => process.exit(0)); });

// One page, one action at a time: parallel tool calls from a council or a multi-call turn queue up.
let queue = Promise.resolve();
const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

export async function test() {
  if (!(await available())) throw new Error('Playwright is not installed. Use Install in the Connect tab.');
  const p = await current();
  await p.goto('about:blank');
  return 'Browser ready (Chromium, persistent profile).';
}

export async function tools() {
  return list().map((t) => ({ ...t, run: (args) => serial(() => t.run(args ?? {})) }));
}
function list() {
  return [
    { name: 'open', description: 'Open a URL in the hub\'s browser and return the page title and visible text.', input_schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
      async run({ url }) { if (!/^https?:\/\//i.test(url)) throw new Error('open needs an http(s) URL.'); const p = await current(); await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); await p.waitForTimeout(600); return summary(p); } },
    { name: 'read', description: 'The current page\'s title, URL and visible text.', input_schema: { type: 'object', properties: {} }, async run() { return summary(await current()); } },
    { name: 'links', description: 'Links on the current page (text and href), up to 80.', input_schema: { type: 'object', properties: {} },
      async run() { const p = await current(); return p.evaluate(() => [...document.querySelectorAll('a[href]')].slice(0, 80).map((a) => ({ text: a.innerText.trim().slice(0, 80), href: a.href }))); } },
    { name: 'click', description: 'Click an element by visible text or CSS selector, then return the page.', input_schema: { type: 'object', properties: { text: { type: 'string' }, selector: { type: 'string' } } },
      async run(a) { const p = await current(); await target(p, a).click({ timeout: 10000 }); await p.waitForLoadState('domcontentloaded').catch(() => {}); await p.waitForTimeout(500); return summary(p); } },
    { name: 'fill', description: 'Type into a field found by CSS selector or its label/placeholder text. Set submit=true to press Enter after.', input_schema: { type: 'object', required: ['value'], properties: { selector: { type: 'string' }, text: { type: 'string', description: 'Label or placeholder text' }, value: { type: 'string' }, submit: { type: 'boolean' } } },
      async run({ selector, text, value, submit }) { const p = await current(); const el = selector ? p.locator(selector).first() : p.getByLabel(text).or(p.getByPlaceholder(text)).first(); await el.fill(value, { timeout: 10000 }); if (submit) { await el.press('Enter'); await p.waitForLoadState('domcontentloaded').catch(() => {}); } return summary(p); } },
    { name: 'screenshot', description: 'Take a screenshot of the current page. Returns an image path the hub shows to Jonathan.', input_schema: { type: 'object', properties: { fullPage: { type: 'boolean' } } },
      async run({ fullPage }) { const p = await current(); await mkdir(SHOTS, { recursive: true }); const file = `${Date.now().toString(36)}.png`; await p.screenshot({ path: fileURLToPath(new URL(file, SHOTS)), fullPage: Boolean(fullPage) }); return { image: `/images/${file}`, url: p.url(), title: await p.title() }; } },
    { name: 'back', description: 'Go back one page.', input_schema: { type: 'object', properties: {} }, async run() { const p = await current(); await p.goBack({ timeout: 10000 }).catch(() => {}); return summary(p); } },
  ];
}
