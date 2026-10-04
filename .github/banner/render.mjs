// Renders banner.html to PNG frames: node render.mjs <frames> <outdir> [social]
import { mkdirSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const [n, out, social] = [Number(process.argv[2] || 1), process.argv[3] || 'frames', process.argv[4] === 'social'];
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: social ? 640 : 400 } });
await page.goto(pathToFileURL(new URL('banner.html', import.meta.url).pathname).href + (social ? '?social' : ''));
await page.waitForFunction(() => window.ready);
if (!(await page.evaluate(() => [...document.fonts].some((f) => f.family === 'Inter' && f.status === 'loaded')))) {
  throw new Error('the Inter font did not load: allow fonts.gstatic.com, or put inter.woff2 next to banner.html');
}
const el = await page.$('#b');
for (let i = 0; i < n; i++) {
  await page.evaluate((t) => window.render(t), i / n);
  await el.screenshot({ path: `${out}/${String(i).padStart(4, '0')}.png` });
}
await browser.close();
console.log(`${n} frames in ${out}`);
