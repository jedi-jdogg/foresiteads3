// Report writers: CSV (one row per variant) and a self-contained HTML dashboard.

const money = (n, d = 0) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (x, d = 0) => (x == null ? '—' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function writeCsv(analysis) {
  const header = [
    'product_id', 'product_title', 'vendor', 'product_type', 'variant_id', 'variant_title', 'sku',
    'current_price', 'compare_at_price', 'unit_cost', 'recommended_price', 'change_pct',
    'tier', 'score', 'confidence', 'units_12mo', 'net_sales_12mo', 'discount_rate',
    'observed_elasticity', 'trend_ratio', 'est_revenue_delta', 'est_profit_delta', 'flags', 'notes',
  ];
  const lines = [header.join(',')];
  for (const r of analysis.results) {
    const rec = r.recommendation;
    const s = r.signals;
    for (const v of rec.variants) {
      lines.push(
        [
          r.id, r.title, r.vendor, r.productType, v.id, v.title, v.sku,
          v.price.toFixed(2), v.compareAtPrice == null ? '' : v.compareAtPrice.toFixed(2), v.unitCost == null ? '' : v.unitCost.toFixed(2),
          v.newPrice.toFixed(2), (v.changePct * 100).toFixed(2),
          rec.tierLabel, r.score.toFixed(3), r.confidence, r.sales.units, r.sales.net.toFixed(2),
          s.discountDependence.rate == null ? '' : (s.discountDependence.rate * 100).toFixed(1),
          s.priceTolerance.elasticity == null ? '' : s.priceTolerance.elasticity.toFixed(2),
          s.trend.ratio == null ? '' : s.trend.ratio.toFixed(2),
          rec.impact.revenueDelta.toFixed(0), rec.impact.profitDelta == null ? '' : rec.impact.profitDelta.toFixed(0),
          [...s.competition.flags, ...s.scarcity.reasons].join('; '), rec.notes.join('; '),
        ].map(csvCell).join(','),
      );
    }
  }
  return lines.join('\n') + '\n';
}

// ---- HTML ---------------------------------------------------------------------------------

const TIER_META = {
  'raise-now': { title: 'Raise now', blurb: 'Strong, repeated evidence that demand does not react to price. Move 8% and keep the strike-through.', tone: 'good' },
  raise: { title: 'Raise', blurb: 'Demand is steady and discounts are light. A 5% move is unlikely to show up in units.', tone: 'good' },
  test: { title: 'Test', blurb: 'Mixed signals. Try 3% on these and watch weekly units for four weeks before going further.', tone: 'caution' },
  hold: { title: 'Hold', blurb: 'Discount-dependent, declining, overstocked or price-matched. Leave these alone for now.', tone: 'muted' },
};

function sparkline(series, months) {
  if (!series.length) return '';
  const w = 96;
  const h = 24;
  const byMonth = new Map(series.map((m) => [m.month, m.units]));
  const pts = months.map((m, i) => [i, byMonth.get(m) ?? null]);
  const max = Math.max(...series.map((m) => m.units), 1);
  const x = (i) => (months.length > 1 ? (i / (months.length - 1)) * (w - 4) + 2 : w / 2);
  const y = (u) => h - 2 - (u / max) * (h - 4);
  const path = pts.filter((p) => p[1] != null).map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join(' ');
  const last = pts.filter((p) => p[1] != null).at(-1);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-label="monthly units"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="${x(last[0]).toFixed(1)}" cy="${y(last[1]).toFixed(1)}" r="2" fill="currentColor"/></svg>`;
}

function chips(r) {
  const s = r.signals;
  const out = [];
  const chip = (text, tone = 'neutral') => out.push(`<span class="chip ${tone}">${esc(text)}</span>`);
  if (s.priceTolerance.elasticity != null) {
    const e = s.priceTolerance.elasticity;
    chip(`price ${pct(s.priceTolerance.priceChange)} → units ${pct(s.priceTolerance.unitsChange)}`, s.priceTolerance.value >= 0.65 ? 'good' : s.priceTolerance.value <= 0.35 ? 'bad' : 'neutral');
    chip(`elasticity ${e.toFixed(2)}`, e > -1 ? 'good' : 'bad');
  } else chip('no price move observed');
  if (s.discountDependence.rate != null) chip(`discounts ${(s.discountDependence.rate * 100).toFixed(1)}% of gross`, s.discountDependence.value >= 0.6 ? 'good' : s.discountDependence.value <= 0.3 ? 'bad' : 'neutral');
  if (s.trend.ratio != null) chip(`trend ${pct(s.trend.ratio - 1)}`, s.trend.ratio >= 1.05 ? 'good' : s.trend.ratio <= 0.85 ? 'bad' : 'neutral');
  if (s.saleFraming.gap > 0) chip(`${(s.saleFraming.gap * 100).toFixed(0)}% under strike-through`, s.saleFraming.gap >= 0.25 ? 'good' : 'neutral');
  for (const reason of s.scarcity.reasons) chip(reason, s.scarcity.value >= 0.8 ? 'good' : 'bad');
  for (const f of s.competition.flags) chip(f, f === 'private label' ? 'good' : f === 'MAP pricing' ? 'bad' : 'caution');
  return out.join('');
}

function priceCell(rec) {
  const vs = rec.variants;
  const range = (get) => {
    const xs = vs.map(get);
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    return lo === hi ? money(lo, 2) : `${money(lo, 2)}–${money(hi, 2)}`;
  };
  const now = range((v) => v.price);
  if (rec.pct === 0) return `<span class="num">${now}</span>`;
  return `<span class="num">${now}</span> <span class="arrow">→</span> <span class="num new">${range((v) => v.newPrice)}</span>`;
}

function row(r, months) {
  const rec = r.recommendation;
  const s = r.signals;
  return `<tr>
  <td class="product"><a href="https://lindas.com/products/${esc(r.handle)}" target="_blank" rel="noopener">${esc(r.title)}</a><div class="meta">${esc(r.vendor)} · ${esc(r.productType)}${rec.variants.length > 1 ? ` · ${rec.variants.length} variants` : ''}</div></td>
  <td class="num"><div>${r.sales.units.toLocaleString('en-US')} units</div><div class="meta">${money(r.sales.net)} net</div>${sparkline(r.series, months)}</td>
  <td>${priceCell(rec)}<div class="meta">${rec.pct ? pct(rec.pct, 1) : 'no change'}${s.competition.map ? ' · verify MAP' : ''}</div></td>
  <td class="num"><div class="scorebar" style="--v:${r.score}"><span></span></div><div>${r.score.toFixed(2)} <span class="meta">${r.confidence}</span></div></td>
  <td class="num">${rec.pct ? `<div>${money(rec.impact.revenueDelta)}</div><div class="meta">${rec.impact.profitDelta == null ? 'cost unknown' : money(rec.impact.profitDelta) + ' profit'}</div>` : '—'}</td>
  <td class="signals">${chips(r)}${rec.notes.length ? `<div class="notes">${rec.notes.map(esc).join(' · ')}</div>` : ''}</td>
</tr>`;
}

function tierSection(key, rows, months, open) {
  const m = TIER_META[key];
  if (!rows.length) return '';
  const table = `<div class="tablewrap"><table>
<thead><tr><th>Product</th><th class="num">12-mo demand</th><th>Price</th><th class="num">Score</th><th class="num">Est. annual Δ</th><th>Why</th></tr></thead>
<tbody>${rows.map((r) => row(r, months)).join('\n')}</tbody></table></div>`;
  return `<details class="tier ${m.tone}" ${open ? 'open' : ''}>
<summary><span class="count">${rows.length}</span><span class="tiertitle">${m.title}</span><span class="blurb">${m.blurb}</span></summary>
${table}
</details>`;
}

export function writeHtml(analysis, summary) {
  const byTier = { 'raise-now': [], raise: [], test: [], hold: [] };
  for (const r of analysis.results) byTier[r.recommendation.tier].push(r);
  const months = analysis.months;
  const first = months[0];
  const last = months.at(-1);
  const fmtMonth = (m) => new Date(m + '-15').toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  const generated = new Date(analysis.generatedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const actionable = (byTier['raise-now'].length + byTier.raise.length + byTier.test.length);

  return `<title>Linda's Pricing Headroom</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{--bg:#F3F2ED;--surface:#FBFAF7;--ink:#1F2933;--muted:#66717C;--line:#D9D7CF;--accent:#0F766E;--accent-ink:#0B5C56;--accent-soft:#DDEDEA;--caution:#B45309;--caution-soft:#F5E7D3;--bad:#B42318;--bad-soft:#F6DEDA;--good:#0F766E;--good-soft:#DDEDEA;--neutral-soft:#E7E6E0;--spark:#4B5563;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151A1E;--surface:#1D2429;--ink:#E7EAEC;--muted:#98A2AB;--line:#2E373E;--accent:#3FB8A8;--accent-ink:#8FDCD1;--accent-soft:#183833;--caution:#E8A24A;--caution-soft:#3B2A14;--bad:#F08A7E;--bad-soft:#421D1A;--good:#3FB8A8;--good-soft:#183833;--neutral-soft:#262E34;--spark:#AAB4BC;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#151A1E;--surface:#1D2429;--ink:#E7EAEC;--muted:#98A2AB;--line:#2E373E;--accent:#3FB8A8;--accent-ink:#8FDCD1;--accent-soft:#183833;--caution:#E8A24A;--caution-soft:#3B2A14;--bad:#F08A7E;--bad-soft:#421D1A;--good:#3FB8A8;--good-soft:#183833;--neutral-soft:#262E34;--spark:#AAB4BC;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "IBM Plex Sans",system-ui,sans-serif}
a{color:inherit}
.page{max-width:1240px;margin:0 auto;padding:40px 28px 64px}
header{display:grid;grid-template-columns:1fr auto;gap:24px;align-items:end;padding-bottom:24px;border-bottom:2px solid var(--ink)}
.eyebrow{font:500 12px/1 "IBM Plex Mono",monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
h1{font:700 40px/1.05 "Familjen Grotesk",system-ui,sans-serif;margin:0;letter-spacing:-.01em;text-wrap:balance}
.lede{max-width:62ch;margin:14px 0 0;color:var(--muted)}
.stamp{font:400 13px/1.6 "IBM Plex Mono",monospace;color:var(--muted);text-align:right}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);border:1px solid var(--line);margin:28px 0 36px}
.tile{background:var(--surface);padding:18px 20px}
.tile .k{font:500 12px/1 "IBM Plex Mono",monospace;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.tile .v{font:600 32px/1.1 "Familjen Grotesk",system-ui,sans-serif;margin-top:10px;font-variant-numeric:tabular-nums}
.tile .v.accent{color:var(--accent-ink)}
.tile .s{color:var(--muted);font-size:13px;margin-top:6px}
h2{font:600 22px/1.2 "Familjen Grotesk",system-ui,sans-serif;margin:40px 0 8px}
.tier{border:1px solid var(--line);background:var(--surface);margin:0 0 16px}
.tier summary{display:grid;grid-template-columns:auto auto 1fr;gap:16px;align-items:baseline;padding:16px 20px;cursor:pointer;list-style:none}
.tier summary::-webkit-details-marker{display:none}
.tier summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.count{font:600 26px/1 "Familjen Grotesk",system-ui,sans-serif;min-width:2ch;font-variant-numeric:tabular-nums}
.tiertitle{font:600 18px/1 "Familjen Grotesk",system-ui,sans-serif;padding-left:12px;border-left:3px solid var(--neutral-soft)}
.tier.good .tiertitle{border-color:var(--good)}.tier.caution .tiertitle{border-color:var(--caution)}
.blurb{color:var(--muted);font-size:14px}
.tablewrap{overflow-x:auto;border-top:1px solid var(--line)}
table{width:100%;border-collapse:collapse;min-width:980px}
th{font:500 11px/1 "IBM Plex Mono",monospace;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:12px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
td.product{min-width:260px;max-width:340px}
td.product a{text-decoration:none;font-weight:500}
td.product a:hover{text-decoration:underline}
.meta{color:var(--muted);font-size:12.5px;margin-top:3px}
.num,th.num{font-variant-numeric:tabular-nums;font-family:"IBM Plex Mono",monospace;font-size:13.5px;white-space:nowrap}
.num.new{color:var(--accent-ink);font-weight:500}
.arrow{color:var(--muted)}
.spark{display:block;margin-top:6px;color:var(--spark)}
.scorebar{width:84px;height:6px;background:var(--neutral-soft);position:relative;margin:6px 0 4px}
.scorebar span{position:absolute;inset:0;width:calc(var(--v)*100%);background:var(--accent)}
td.signals{min-width:280px;max-width:420px}
.chip{display:inline-block;font:500 11.5px/1 "IBM Plex Mono",monospace;padding:5px 7px;margin:0 4px 4px 0;background:var(--neutral-soft);border-radius:2px;white-space:nowrap}
.chip.good{background:var(--good-soft);color:var(--good)}
.chip.bad{background:var(--bad-soft);color:var(--bad)}
.chip.caution{background:var(--caution-soft);color:var(--caution)}
.notes{font-size:12.5px;color:var(--caution);margin-top:4px}
.method{margin-top:48px;padding-top:24px;border-top:2px solid var(--ink);display:grid;grid-template-columns:1fr 1fr;gap:32px}
.method h3{font:600 15px/1.2 "Familjen Grotesk",system-ui,sans-serif;margin:0 0 8px}
.method p,.method li{font-size:14px;color:var(--muted);max-width:62ch}
.method ul{padding-left:18px;margin:0}
.method code{font:400 12.5px "IBM Plex Mono",monospace;color:var(--ink)}
@media (max-width:820px){header{grid-template-columns:1fr}.stamp{text-align:left}.tiles{grid-template-columns:1fr 1fr}.method{grid-template-columns:1fr}h1{font-size:32px}}
@media (prefers-reduced-motion:no-preference){.scorebar span{transition:width .3s}}
</style>
<div class="page">
<header>
  <div>
    <p class="eyebrow">Linda's Electric Quilters · lindas.com · Shopify Plus</p>
    <h1>Where a price can go up without the yardage going down</h1>
    <p class="lede">${actionable} of ${summary.products} revenue-leading products show room for a price increase. Scores combine how units reacted to past price moves, how little of each sale is discounted, demand trend and stability, the gap under the strike-through price, scarcity, and whether the SKU is price-matched elsewhere.</p>
  </div>
  <div class="stamp">Generated ${generated}<br>Window ${fmtMonth(first)} – ${fmtMonth(last)}<br>Impact = next 12 months at current demand</div>
</header>

<div class="tiles">
  <div class="tile"><div class="k">Products scored</div><div class="v">${summary.products}</div><div class="s">${summary.skipped} skipped (protection, memberships, gift cards, inactive)</div></div>
  <div class="tile"><div class="k">Raise now</div><div class="v accent">${byTier['raise-now'].length}</div><div class="s">+ ${byTier.raise.length} raise · ${byTier.test.length} test · ${byTier.hold.length} hold</div></div>
  <div class="tile"><div class="k">Est. annual revenue</div><div class="v accent">${money(summary.revenueDelta)}</div><div class="s">after assumed unit loss per tier</div></div>
  <div class="tile"><div class="k">Est. annual profit</div><div class="v accent">${money(summary.profitDelta)}</div><div class="s">using Shopify unit costs where recorded</div></div>
</div>

${tierSection('raise-now', byTier['raise-now'], months, true)}
${tierSection('raise', byTier.raise, months, true)}
${tierSection('test', byTier.test, months, false)}
${tierSection('hold', byTier.hold, months, false)}

<section class="method">
  <div>
    <h3>How the score is built</h3>
    <ul>
      <li><strong>Price tolerance (25%)</strong> — realised price (net sales ÷ units) in the second half of the window vs the first. If it moved 5%+ the units response gives an observed elasticity. Between −1 and 0 means units fell less than price rose.</li>
      <li><strong>Discount dependence (20%)</strong> — discounts as a share of gross. Under 2% scores full marks; over 15% scores zero.</li>
      <li><strong>Trend (15%)</strong> and <strong>stability (10%)</strong> — second-half vs first-half units, and month-to-month coefficient of variation.</li>
      <li><strong>Strike-through headroom (10%)</strong> — room between price and compare-at. Raising while staying under it keeps the sale framing.</li>
      <li><strong>Scarcity (10%)</strong> — pre-order items, tracked stock at zero while selling, or 90-day sell-through above 70%.</li>
      <li><strong>Competition (10%)</strong> — private label scores high; MAP-priced and drop-shipped SKUs score low because the same item is sold elsewhere at the same price.</li>
    </ul>
  </div>
  <div>
    <h3>Read the numbers with these caveats</h3>
    <ul>
      <li>Monthly history comes from each month's top 300 products by net sales, so a missing month means "not in the top 300", not zero. Confidence reflects how many months were seen.</li>
      <li>Impact assumes units fall by <code>elasticity × price change</code> with elasticity −0.5 (raise now), −0.8 (raise) and −1.0 (test). Revenue is 12-month net sales; profit uses the variant unit cost recorded in Shopify.</li>
      <li>New prices are rounded to end in 9 and capped 5% under the compare-at price. MAP-priced brands are capped at +3%; check the manufacturer's current MAP before changing them.</li>
      <li>Roll and by-the-yard versions of the same batting are scored separately. Raise them together so the per-yard math still favours the roll.</li>
      <li>Nothing here changes a price. Review the CSV, then apply through Shopify's bulk editor or a price list.</li>
    </ul>
  </div>
</section>
</div>
`;
}
