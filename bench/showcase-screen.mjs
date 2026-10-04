// The screen-recording clip for showcase.py: 45 frames of scrolling down the lessgif website,
// taken as screenshots so the source has no video compression of its own.
//   node site/build.mjs && node bench/showcase-screen.mjs
// Needs Playwright (set PLAYWRIGHT to its index.mjs if it isn't installed where Node looks).
import { createServer } from 'node:http';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const here = fileURLToPath(new URL('.', import.meta.url));
const dist = join(here, '..', 'site', 'dist');
const out = join(here, 'data', 'showcase', 'screen');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  try {
    const body = await readFile(join(dist, p));
    res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(0, '127.0.0.1');
await new Promise((ok) => server.once('listening', ok));

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForLoadState('networkidle');
const N = 45, distance = 760;
for (let i = 0; i < N; i++) {
  const t = i / (N - 1);
  const ease = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
  await page.evaluate((y) => window.scrollTo(0, y), Math.round(ease * distance));
  await page.screenshot({ path: join(out, `${String(i + 1).padStart(4, '0')}.png`) });
}
await browser.close();
server.close();
console.log(`${N} frames in ${out}`);
