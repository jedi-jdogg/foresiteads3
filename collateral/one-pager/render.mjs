import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const dir = '/tmp/claude-0/-home-user-foresiteads3/b8363b14-8558-5926-8c9e-0f77858f07ba/scratchpad/onepager';
const jobs = [
  { html: 'index.html', pdf: 'Foresite_One_Pager.pdf', shot: 'print-preview.png' },
  { html: 'index-single.html', pdf: 'Foresite_One_Pager_Single_Page.pdf', shot: 'print-preview-single.png' },
];
const b = await chromium.launch();
for (const j of jobs) {
  const p = await b.newPage({ viewport: { width: 900, height: 1200 } });
  await p.goto('file://' + dir + '/' + j.html, { waitUntil: 'load' });
  await p.evaluate(() => document.fonts.ready);
  await p.emulateMedia({ media: 'print' });
  const hs = await p.evaluate(() => [...document.querySelectorAll('.page')].map(e => e.getBoundingClientRect().height));
  console.log(j.html, 'print heights:', hs.map(h => Math.round(h)), 'letter=1056');
  let css = '';
  hs.forEach((h, i) => {
    if (h > 1056) {
      const z = Math.floor((1052 / h) * 1000) / 1000;
      console.log(`  page ${i+1}: zoom ${z}`);
      css += `@media print{ .page:nth-of-type(${i+1}){ zoom:${z}; min-height: calc(11in / ${z}); width: calc(8.5in / ${z}); } }`;
    }
  });
  if (css) await p.addStyleTag({ content: css });
  await p.pdf({ path: dir + '/' + j.pdf, format: 'Letter', printBackground: true, preferCSSPageSize: true });
  await p.setViewportSize({ width: 816, height: 1056 });
  await p.screenshot({ path: dir + '/' + j.shot, fullPage: true });
  await p.close();
}
await b.close();
