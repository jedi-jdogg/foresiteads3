import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discountDependence, trend, stability, priceTolerance, saleFraming, scarcity, competition, scoreProduct, isExcluded, WEIGHTS } from '../src/score.js';
import { recommend, psychologicalRound } from '../src/recommend.js';

const series = (units, prices) => units.map((u, i) => ({ month: `2026-${String(i + 1).padStart(2, '0')}`, units: u, net: u * prices[i], gross: u * prices[i], discounts: 0 }));
const product = (over = {}) => ({
  id: '1', title: 'Test Batting Roll', handle: 'test', vendor: 'Hobbs', productType: 'Batting', tags: [], status: 'ACTIVE', totalInventory: 10,
  variants: [{ id: 'v1', title: 'Default', sku: 'X', price: 100, compareAtPrice: 140, inventoryQuantity: 10, tracked: true, unitCost: 60 }],
  ...over,
});

test('weights sum to 1', () => {
  assert.ok(Math.abs(Object.values(WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('discount dependence: light discounting scores high, heavy scores zero', () => {
  assert.equal(discountDependence({ gross: 1000, discounts: 10 }).value, 1);
  assert.equal(discountDependence({ gross: 1000, discounts: 200 }).value, 0);
  assert.ok(discountDependence({ gross: 1000, discounts: 80 }).value > 0.4);
});

test('trend: growing demand scores above 0.5, shrinking below', () => {
  assert.ok(trend(series([10, 10, 10, 15, 15, 15], [1, 1, 1, 1, 1, 1])).value > 0.9);
  assert.ok(trend(series([20, 20, 20, 10, 10, 10], [1, 1, 1, 1, 1, 1])).value < 0.1);
  assert.equal(trend(series([1, 2], [1, 1])).value, 0.5);
});

test('stability: flat series is stable, spiky is not', () => {
  assert.equal(stability(series([10, 10, 10, 10], [1, 1, 1, 1])).value, 1);
  assert.ok(stability(series([1, 40, 2, 50], [1, 1, 1, 1])).value < 0.2);
});

test('price tolerance: price up 10% with units flat is inelastic', () => {
  const r = priceTolerance(series([10, 10, 10, 10, 10, 10], [100, 100, 100, 110, 110, 110]));
  assert.ok(r.priceChange > 0.09);
  assert.equal(r.value, 1);
});

test('price tolerance: price up 10%, units down 30% is elastic', () => {
  const r = priceTolerance(series([10, 10, 10, 7, 7, 7], [100, 100, 100, 110, 110, 110]));
  assert.ok(r.elasticity < -2);
  assert.equal(r.value, 0.1);
});

test('price tolerance: no price movement is neutral', () => {
  assert.equal(priceTolerance(series([10, 12, 9, 11], [50, 50, 50, 50])).value, 0.5);
});

test('sale framing rewards headroom under compare-at', () => {
  assert.ok(saleFraming(product()).value > 0.9);
  assert.equal(saleFraming(product({ variants: [{ price: 10, compareAtPrice: null, tracked: false, inventoryQuantity: 0 }] })).value, 0.4);
});

test('scarcity: pre-order and stock-outs score high, overstock low', () => {
  assert.equal(scarcity(product({ tags: ['Pre-Order'] }), { units: 5 }).value, 0.9);
  assert.equal(scarcity(product({ variants: [{ price: 1, tracked: true, inventoryQuantity: 0 }] }), { units: 5 }).value, 0.8);
  assert.equal(scarcity(product(), { units: 5 }, { sellThrough: 0.05, ending: 5000 }).value, 0.2);
});

test('competition: private label high, MAP low, drop-ship low', () => {
  assert.equal(competition(product({ vendor: "Linda's Electric Quilters" })).value, 1);
  assert.equal(competition(product({ tags: ['MAP Pricing'] })).value, 0.2);
  assert.equal(competition(product({ tags: ['intent:drop-ship'] })).value, 0.35);
});

test('exclusions', () => {
  assert.ok(isExcluded(null, { productId: '', title: '' }));
  assert.ok(isExcluded(product({ title: 'ShipInsure Package Protection' }), { productId: '9', title: '' }));
  assert.ok(!isExcluded(product(), { productId: '1', title: 'x' }));
});

test('psychological rounding ends in 9', () => {
  assert.equal(psychologicalRound(108), 107.99);
  assert.equal(psychologicalRound(13.3), 13.29);
  assert.equal(psychologicalRound(0.5), 0.5);
});

test('recommend: high score with good history raises 8% and caps under compare-at', () => {
  const s = series([50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50], [100, 100, 100, 100, 100, 100, 110, 110, 110, 110, 110, 110]);
  const p = product({ vendor: "Linda's Electric Quilters" });
  const sales = { units: 600, gross: 63000, discounts: 500, net: 62500 };
  const scored = scoreProduct({ product: p, sales, series: s, inventory: { sellThrough: 0.8, ending: 20 } });
  assert.ok(scored.score >= 0.72, `score ${scored.score}`);
  const rec = recommend(scored, { product: p, sales });
  assert.equal(rec.tier, 'raise-now');
  assert.equal(rec.variants[0].newPrice, 107.99);
  assert.ok(rec.impact.revenueDelta > 0);
  assert.ok(rec.impact.profitDelta > rec.impact.revenueDelta * 0.5);
});

test('recommend: MAP-priced product is capped at 3%', () => {
  const s = series([50, 50, 50, 50, 50, 50, 50, 50], [100, 100, 100, 100, 110, 110, 110, 110]);
  const p = product({ tags: ['MAP Pricing'] });
  const sales = { units: 400, gross: 42000, discounts: 300, net: 41700 };
  const rec = recommend(scoreProduct({ product: p, sales, series: s }), { product: p, sales });
  assert.ok(rec.pct <= 0.03 + 1e-9);
});

test('recommend: declining demand is held', () => {
  const s = series([50, 50, 50, 50, 20, 20, 20, 20], [100, 100, 100, 100, 100, 100, 100, 100]);
  const p = product({ vendor: "Linda's Electric Quilters" });
  const sales = { units: 280, gross: 28000, discounts: 100, net: 27900 };
  const rec = recommend(scoreProduct({ product: p, sales, series: s }), { product: p, sales });
  assert.equal(rec.tier, 'hold');
  assert.equal(rec.variants[0].newPrice, 100);
});
