import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const dir = '/tmp/claude-0/-home-user-foresiteads3/b8363b14-8558-5926-8c9e-0f77858f07ba/scratchpad/onepager';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 900, height: 1200 } });
await p.goto('file://' + dir + '/index.html', { waitUntil: 'load' });
await p.evaluate(() => document.fonts.ready);
await p.emulateMedia({ media: 'print' });
let h = await p.evaluate(() => document.querySelector('.page').getBoundingClientRect().height);
console.log('print content height px:', h, ' letter=1056');
if (h > 1056) {
  const z = Math.floor((1052 / h) * 1000) / 1000;
  console.log('applying print zoom', z);
  await p.addStyleTag({ content: `@media print{ .page{ zoom:${z}; min-height: calc(11in / ${z}); width: calc(8.5in / ${z}); } }` });
  h = await p.evaluate(() => document.querySelector('.page').getBoundingClientRect().height);
  console.log('after zoom height px:', h);
}
await p.pdf({ path: dir + '/Foresite_One_Pager.pdf', format: 'Letter', printBackground: true, preferCSSPageSize: true });
await p.emulateMedia({ media: 'screen' });
await p.screenshot({ path: dir + '/preview.png', fullPage: true });
await b.close();
