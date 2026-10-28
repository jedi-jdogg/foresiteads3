#!/usr/bin/env node
// Writes public/preview.html: the console with the roster and playbook baked in, so it can be opened
// (or published) without the hub running. Routing is real; answers are samples.
import { writeFile } from 'node:fs/promises';
import { loadRoster } from '../src/registry.js';
import { Hub } from '../src/hub.js';
import { renderPage } from '../src/server.js';

const hub = new Hub(await loadRoster(undefined, {}), { log: false });
const out = new URL('../public/preview.html', import.meta.url);
await writeFile(out, await renderPage(hub));
console.log(`wrote ${out.pathname}`);
