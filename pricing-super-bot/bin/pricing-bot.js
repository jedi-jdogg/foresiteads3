#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeSnapshot, summarize } from '../src/analyze.js';
import { writeCsv, writeHtml } from '../src/report.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    snapshot: { type: 'string', default: './data' },
    out: { type: 'string', default: './reports' },
    'min-revenue': { type: 'string', default: '0' },
    store: { type: 'string' },
    token: { type: 'string' },
    'api-version': { type: 'string' },
    top: { type: 'string', default: '250' },
    months: { type: 'string', default: '12' },
    name: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const cmd = positionals[0];
if (values.help || !cmd) {
  console.log(`Linda's pricing super bot

  pricing-bot fetch   --out ./data [--store X --token Y --top 250 --months 12]
      Pull a fresh snapshot from the Shopify Admin API (or set SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN).

  pricing-bot analyze --snapshot ./data --out ./reports [--min-revenue 1000] [--name 2026-09-08]
      Score every product in the snapshot and write <name>-lindas-pricing.{html,csv,json}.
`);
  process.exit(0);
}

if (cmd === 'fetch') {
  const { fetchSnapshot } = await import('../src/fetch.js');
  await fetchSnapshot({
    outDir: values.out,
    store: values.store ?? process.env.SHOPIFY_STORE,
    token: values.token ?? process.env.SHOPIFY_ADMIN_TOKEN,
    version: values['api-version'] ?? process.env.SHOPIFY_API_VERSION ?? '2026-07',
    top: Number(values.top),
    months: Number(values.months),
  });
} else if (cmd === 'analyze') {
  const analysis = await analyzeSnapshot(values.snapshot, { minRevenue: Number(values['min-revenue']) });
  const summary = summarize(analysis);
  await mkdir(values.out, { recursive: true });
  const base = join(values.out, `${values.name ?? analysis.generatedAt.slice(0, 10)}-lindas-pricing`);
  await writeFile(base + '.json', JSON.stringify({ summary, ...analysis }, null, 1));
  await writeFile(base + '.csv', writeCsv(analysis));
  await writeFile(base + '.html', writeHtml(analysis, summary));
  const money = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  console.log(`Scored ${summary.products} products (${summary.skipped} skipped).`);
  console.log(`  raise now ${summary.byTier['raise-now'] ?? 0} · raise ${summary.byTier.raise ?? 0} · test ${summary.byTier.test ?? 0} · hold ${summary.byTier.hold ?? 0}`);
  console.log(`  est. annual revenue change ${money(summary.revenueDelta)}, profit change ${money(summary.profitDelta)}`);
  console.log(`  wrote ${base}.{html,csv,json}`);
} else {
  console.error(`unknown command: ${cmd}`);
  process.exit(1);
}
