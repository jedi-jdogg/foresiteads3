// Pure scoring logic. No I/O. Every signal is normalised to 0..1 where 1 = "demand is unlikely
// to react to a price increase". The composite score is a weighted sum of the signals.

export const WEIGHTS = {
  priceTolerance: 0.25, // observed reaction of units to realised-price changes
  discountDependence: 0.2, // share of gross sales given away as discounts
  trend: 0.15, // recent demand vs earlier demand
  stability: 0.1, // month-to-month volatility of units
  saleFraming: 0.1, // room between price and compare-at (strike-through) price
  scarcity: 0.1, // pre-order, stock-outs, sell-through
  competition: 0.1, // private label vs MAP-priced / drop-shipped commodity
};

export const EXCLUDE_TITLE = /shipinsure|package protection|gift card|membership|free download|digital download|fat quarterly|spec chart|sample pack/i;
export const EXCLUDE_TYPES = new Set(['Gift Card', 'Membership', 'Digital Download', 'Service']);

export const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sd = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

export function isExcluded(product, salesRow) {
  const title = product?.title || salesRow?.title || '';
  if (!salesRow?.productId || salesRow.productId === '0') return true;
  if (EXCLUDE_TITLE.test(title)) return true;
  if (product && EXCLUDE_TYPES.has(product.productType)) return true;
  if (product && product.variants.every((v) => v.price === 0)) return true;
  return false;
}

// ---- individual signals -------------------------------------------------------------------

export function discountDependence(sales) {
  if (!sales.gross) return { value: 0.5, rate: null };
  const rate = sales.discounts / sales.gross;
  // 2% or less of gross given away → 1.0; 15% or more → 0.
  return { value: clamp(1 - (rate - 0.02) / 0.13), rate };
}

export function splitHalves(series) {
  // series: [{month, units, net}] sorted by month, only months with data
  const n = series.length;
  const cut = Math.floor(n / 2);
  return { first: series.slice(0, cut), second: series.slice(cut) };
}

export function trend(series) {
  if (series.length < 4) return { value: 0.5, ratio: null };
  const { first, second } = splitHalves(series);
  const a = mean(first.map((m) => m.units));
  const b = mean(second.map((m) => m.units));
  if (!a) return { value: 0.5, ratio: null };
  const ratio = b / a;
  // flat (1.0) → 0.5; +50% → 1.0; −50% → 0.
  return { value: clamp(0.5 + (ratio - 1)), ratio };
}

export function stability(series) {
  if (series.length < 4) return { value: 0.5, cv: null };
  const units = series.map((m) => m.units);
  const m = mean(units);
  if (!m) return { value: 0.5, cv: null };
  const cv = sd(units) / m;
  // CV 0.2 or lower → 1.0; CV 1.0 or higher → 0.
  return { value: clamp(1 - (cv - 0.2) / 0.8), cv };
}

// Realised price = net sales / units for a month. If the realised price moved by 5%+ between the
// two halves of the window, the units response gives an observed arc elasticity.
export function priceTolerance(series) {
  if (series.length < 4) return { value: 0.5, elasticity: null, priceChange: null, unitsChange: null };
  const { first, second } = splitHalves(series);
  const rp = (rows) => {
    const u = rows.reduce((a, r) => a + r.units, 0);
    const n = rows.reduce((a, r) => a + r.net, 0);
    return u ? n / u : 0;
  };
  const p1 = rp(first);
  const p2 = rp(second);
  const q1 = mean(first.map((m) => m.units));
  const q2 = mean(second.map((m) => m.units));
  if (!p1 || !q1) return { value: 0.5, elasticity: null, priceChange: null, unitsChange: null };
  const dp = (p2 - p1) / p1;
  const dq = (q2 - q1) / q1;
  // Below a 5% realised-price move the ratio is dominated by variant mix and noise.
  if (Math.abs(dp) < 0.05) return { value: 0.5, elasticity: null, priceChange: dp, unitsChange: dq };
  const e = Math.max(-10, Math.min(10, dq / dp));
  let value;
  if (dp > 0) {
    // price went up: how much did units fall?
    value = e >= 0 ? 1 : e >= -0.5 ? 0.85 : e >= -1 ? 0.65 : e >= -2 ? 0.35 : 0.1;
  } else {
    // price went down: if units surged, demand may be elastic (or the product was ramping);
    // if units barely moved, the lower price bought nothing.
    value = e <= -1.5 ? 0.4 : e <= -0.5 ? 0.5 : 0.7;
  }
  return { value, elasticity: e, priceChange: dp, unitsChange: dq };
}

export function saleFraming(product) {
  const gaps = product.variants
    .filter((v) => v.price > 0 && v.compareAtPrice != null && v.compareAtPrice > v.price)
    .map((v) => (v.compareAtPrice - v.price) / v.price);
  if (!gaps.length) return { value: 0.4, gap: 0 };
  const gap = mean(gaps);
  // 0% gap → 0.3; 40%+ headroom under the strike-through → 1.0
  return { value: clamp(0.3 + gap * 1.75), gap };
}

export function scarcity(product, sales, inventory) {
  const title = product.title.toLowerCase();
  const tags = product.tags.map((t) => t.toLowerCase());
  const preOrder = /pre-order|preorder/.test(title) || tags.includes('pre-order');
  const tracked = product.variants.some((v) => v.tracked);
  const stockedOut = tracked && product.variants.every((v) => v.inventoryQuantity <= 0);
  const st = inventory?.sellThrough;
  const reasons = [];
  let value = 0.5;
  if (preOrder) {
    value = 0.9;
    reasons.push('customers pre-order and wait');
  } else if (stockedOut && sales.units > 0) {
    value = 0.8;
    reasons.push('tracked stock at zero while still selling');
  } else if (st != null && tracked && st >= 0.7) {
    value = 0.8;
    reasons.push(`90-day sell-through ${(st * 100).toFixed(0)}%`);
  } else if (st != null && tracked && st <= 0.1 && (inventory?.ending ?? 0) > 200) {
    value = 0.2;
    reasons.push(`overstocked: ${inventory.ending} units, ${(st * 100).toFixed(0)}% sell-through`);
  }
  return { value, reasons, preOrder, stockedOut, sellThrough: st ?? null };
}

export function competition(product) {
  const tags = product.tags.map((t) => t.toLowerCase());
  const privateLabel =
    /linda'?s/i.test(product.vendor) || tags.includes('brand:lindas') || /linda'?s /i.test(product.title);
  const map = tags.some((t) => t.includes('map pricing'));
  const dropShip = tags.some((t) => t === 'intent:drop-ship' || /-ds$/.test(t) || t === 'dropship-checkers');
  const collective = tags.some((t) => t === 'shopify collective');
  const flags = [];
  let value = 0.5;
  if (privateLabel) {
    value = 1;
    flags.push('private label');
  }
  if (map) {
    value = Math.min(value, 0.2);
    flags.push('MAP pricing');
  }
  if (dropShip) {
    value = Math.min(value, privateLabel ? 0.7 : 0.35);
    flags.push('drop-ship');
  }
  if (collective) flags.push('Shopify Collective');
  return { value, flags, privateLabel, map, dropShip, collective };
}

// ---- composite ---------------------------------------------------------------------------

export function monthlySeries(monthly, months, productId) {
  const out = [];
  for (const m of months) {
    const row = monthly.get(m)?.find((r) => r.productId === productId);
    if (row && row.units > 0) out.push({ month: m, units: row.units, net: row.net, gross: row.gross, discounts: row.discounts });
  }
  return out;
}

export function confidence(series, sales) {
  if (series.length >= 9 && sales.units >= 100) return 'high';
  if (series.length >= 6 && sales.units >= 40) return 'medium';
  return 'low';
}

export function scoreProduct({ product, sales, series, inventory }) {
  const signals = {
    priceTolerance: priceTolerance(series),
    discountDependence: discountDependence(sales),
    trend: trend(series),
    stability: stability(series),
    saleFraming: saleFraming(product),
    scarcity: scarcity(product, sales, inventory),
    competition: competition(product),
  };
  let score = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) score += w * signals[k].value;
  return { score: Math.round(score * 1000) / 1000, signals, confidence: confidence(series, sales) };
}
