// Turns a score into a concrete recommendation with guardrails and an impact estimate.

export const TIERS = [
  // assumedElasticity drives the impact estimate: units fall by elasticity × price change.
  { key: 'raise-now', label: 'Raise now', minScore: 0.7, pct: 0.08, assumedElasticity: -0.5 },
  { key: 'raise', label: 'Raise', minScore: 0.6, pct: 0.05, assumedElasticity: -0.8 },
  { key: 'test', label: 'Test', minScore: 0.5, pct: 0.03, assumedElasticity: -1.0 },
  { key: 'hold', label: 'Hold', minScore: -Infinity, pct: 0, assumedElasticity: 0 },
];

// Prices in this catalog end in .19/.29/.49/.84/.95/.99 — settle on "x.x9" endings.
export function psychologicalRound(price) {
  if (price < 1) return Math.round(price * 100) / 100;
  const up = Math.ceil(price * 10) / 10 - 0.01;
  const down = Math.floor(price * 10) / 10 - 0.01;
  return Math.abs(up - price) <= Math.abs(price - down) ? +up.toFixed(2) : +down.toFixed(2);
}

export function recommend(scored, { product, sales, series = [] }) {
  const { score, signals, confidence } = scored;
  let tier = TIERS.find((t) => score >= t.minScore);
  const notes = [];

  // Single-variant products: if the list price already sits well above what buyers paid in the
  // last three months, a further move stacks on a recent increase.
  const recent = recentGrossPerUnit(series);
  if (product.variants.length === 1 && recent && product.variants[0].price > recent * 1.05) {
    const over = product.variants[0].price / recent - 1;
    notes.push(`list price is already ${(over * 100).toFixed(0)}% above the average paid in the last 3 months; this stacks on a recent increase`);
  }

  if (confidence === 'low' && tier.key !== 'hold') {
    tier = TIERS.find((t) => t.key === (tier.key === 'raise-now' ? 'raise' : 'test'));
    notes.push('thin sales history: stepped down one tier');
  }
  let pct = tier.pct;
  if (signals.competition.map && pct > 0.03) {
    pct = 0.03;
    notes.push('MAP-priced brand: competitors sell the same SKU, keep the move small and check parity');
  }
  if (signals.competition.dropShip && !signals.competition.privateLabel && pct > 0.05) {
    pct = 0.05;
    notes.push('drop-shipped SKU is widely available, capped at 5%');
  }
  if (signals.trend.ratio != null && signals.trend.ratio < 0.7 && pct > 0) {
    pct = 0;
    tier = TIERS.find((t) => t.key === 'hold');
    notes.push('demand fell more than 30% across the window; do not raise into a decline');
  }
  if (signals.scarcity.value <= 0.2 && pct > 0) {
    pct = 0;
    tier = TIERS.find((t) => t.key === 'hold');
    notes.push('overstocked; clear inventory before repricing');
  }

  const variants = product.variants.map((v) => {
    let target = psychologicalRound(v.price * (1 + pct));
    if (v.compareAtPrice && v.compareAtPrice > v.price) {
      const cap = psychologicalRound(v.compareAtPrice * 0.95);
      if (target > cap) {
        target = Math.max(v.price, cap);
        if (target < psychologicalRound(v.price * (1 + pct))) notes.push('capped to keep at least a 5% strike-through');
      }
    }
    if (pct === 0) target = v.price;
    const margin = v.unitCost != null && v.price ? (v.price - v.unitCost) / v.price : null;
    const newMargin = v.unitCost != null && target ? (target - v.unitCost) / target : null;
    return { ...v, newPrice: target, changePct: v.price ? target / v.price - 1 : 0, margin, newMargin };
  });

  const effectivePct = variants.length
    ? variants.reduce((a, v) => a + v.changePct, 0) / variants.length
    : 0;

  // Impact: units shrink by assumedElasticity × price change; revenue and profit re-computed.
  const e = tier.assumedElasticity;
  const unitFactor = 1 + e * effectivePct;
  const avgPrice = sales.units ? sales.net / sales.units : 0;
  const costRatio = costRatioOf(product);
  const avgCost = costRatio != null ? costRatio * avgPrice : null;
  const revenueNow = sales.net;
  const revenueNew = sales.units * unitFactor * avgPrice * (1 + effectivePct);
  const profitNow = avgCost != null ? sales.units * (avgPrice - avgCost) : null;
  const profitNew = avgCost != null ? sales.units * unitFactor * (avgPrice * (1 + effectivePct) - avgCost) : null;

  return {
    tier: tier.key,
    tierLabel: tier.label,
    pct: effectivePct,
    notes: [...new Set(notes)],
    variants,
    impact: {
      assumedElasticity: e,
      unitsNow: sales.units,
      unitsNew: sales.units * unitFactor,
      revenueNow,
      revenueNew,
      revenueDelta: revenueNew - revenueNow,
      profitNow,
      profitNew,
      profitDelta: profitNow != null ? profitNew - profitNow : null,
    },
  };
}

function recentGrossPerUnit(series) {
  const tail = series.slice(-3);
  const units = tail.reduce((a, m) => a + m.units, 0);
  const gross = tail.reduce((a, m) => a + (m.gross ?? 0), 0);
  return units ? gross / units : null;
}

// No per-variant sales split in the snapshot, so cost is modelled as a ratio of price.
export function costRatioOf(product) {
  const vs = product.variants.filter((v) => v.unitCost != null && v.price > 0);
  if (!vs.length) return null;
  return vs.reduce((a, v) => a + v.unitCost / v.price, 0) / vs.length;
}
