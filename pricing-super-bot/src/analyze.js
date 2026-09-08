import { loadSnapshot } from './normalize.js';
import { isExcluded, monthlySeries, scoreProduct } from './score.js';
import { recommend } from './recommend.js';

export async function analyzeSnapshot(dir, { minRevenue = 0 } = {}) {
  const snap = await loadSnapshot(dir);
  const results = [];
  const skipped = [];
  for (const sales of snap.sales365) {
    const product = snap.products.get(sales.productId);
    if (isExcluded(product, sales)) {
      skipped.push({ id: sales.productId, title: sales.title, reason: 'excluded' });
      continue;
    }
    if (!product) {
      skipped.push({ id: sales.productId, title: sales.title, reason: 'not in catalog snapshot' });
      continue;
    }
    if (product.status !== 'ACTIVE') {
      skipped.push({ id: sales.productId, title: sales.title, reason: `status ${product.status}` });
      continue;
    }
    if (sales.net < minRevenue) continue;
    const series = monthlySeries(snap.monthly, snap.months, sales.productId);
    const inventory = snap.inventory.get(product.title);
    const scored = scoreProduct({ product, sales, series, inventory });
    const rec = recommend(scored, { product, sales, series });
    results.push({
      id: product.id,
      title: product.title,
      handle: product.handle,
      vendor: product.vendor,
      productType: product.productType,
      sales,
      series,
      inventory: inventory ?? null,
      ...scored,
      recommendation: rec,
    });
  }
  results.sort((a, b) => tierRank(a) - tierRank(b) || impactOf(b) - impactOf(a) || b.sales.net - a.sales.net);
  return { generatedAt: new Date().toISOString(), months: snap.months, results, skipped };
}

const ORDER = { 'raise-now': 0, raise: 1, test: 2, hold: 3 };
const tierRank = (r) => ORDER[r.recommendation.tier];
const impactOf = (r) => r.recommendation.impact.profitDelta ?? r.recommendation.impact.revenueDelta;

export function summarize(analysis) {
  const byTier = {};
  let revenueDelta = 0;
  let profitDelta = 0;
  for (const r of analysis.results) {
    const t = r.recommendation.tier;
    byTier[t] = (byTier[t] || 0) + 1;
    if (t !== 'hold') {
      revenueDelta += r.recommendation.impact.revenueDelta;
      profitDelta += r.recommendation.impact.profitDelta ?? 0;
    }
  }
  return { products: analysis.results.length, byTier, revenueDelta, profitDelta, skipped: analysis.skipped.length };
}
