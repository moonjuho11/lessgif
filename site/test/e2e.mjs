// Drives every page of the built site (site/dist) in Chromium and checks the GIFs it makes.
//   sh site/test/make-fixtures.sh && node site/build.mjs && node site/test/e2e.mjs
// Needs Playwright with Chromium (PLAYWRIGHT=<path to playwright/index.mjs> to use a global
// install). Screenshots go to site/test/out/.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { decodeGif, parseGif } from '../assets/gifdecode.js';
import { plan, drawFrame } from '../assets/ops.js';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const fx = (n) => join(here, 'fixtures', n);
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;

// ---- static server
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.xml': 'application/xml', '.txt': 'text/plain' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = join(dist, p);
  if (!f.startsWith(dist) || !existsSync(f) || statSync(f).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' }).end(readFileSync(f));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });

// ---- helpers
const problems = [];
async function open(path) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${path}: page error: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`${path}: console error: ${m.text()}`));
  await page.goto(base + path);
  return page;
}
const upload = (page, files) => page.setInputFiles('label.drop input', files);
async function loaded(page) {
  await page.waitForSelector('form.card:not([hidden])', { timeout: 60000 });
}
async function run(page, timeout = 180000) {
  await page.click('form.card button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#result')?.hidden || !document.querySelector('.note.err')?.hidden, null, { timeout });
  const err = await page.$eval('.note.err', (e) => (e.hidden ? null : e.textContent));
  if (err) throw new Error(`the page showed an error: ${err}`);
  const b64 = await page.$eval('#result a[download]', async (a) => {
    const buf = new Uint8Array(await (await fetch(a.href)).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const facts = await page.$eval('#result .facts', (e) => e.textContent);
  return { bytes: new Uint8Array(Buffer.from(b64, 'base64')), facts };
}
const read = (n) => new Uint8Array(readFileSync(fx(n)));
const dur = (g) => g.delays.reduce((a, b) => a + b, 0);
// index of the frame shown at time t (centiseconds)
function at(g, t) {
  let s = 0;
  for (let i = 0; i < g.delays.length; i++) {
    s += g.delays[i];
    if (t < s) return i;
  }
  return g.delays.length - 1;
}
// largest per-channel difference between two RGBA frames (transparent pixels compare as equal)
function diff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] === 0 && b[i + 3] === 0) continue;
    if (a[i + 3] !== b[i + 3]) return 255;
    m = Math.max(m, Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
  }
  return m;
}
// Compares the output with the expected frames of plan(src, ops) at every expected frame's start.
function expectFrames(out, src, ops) {
  const p = plan(src, ops);
  assert.equal(out.width, p.w, 'width');
  assert.equal(out.height, p.h, 'height');
  assert.equal(dur(out), p.delays.reduce((a, b) => a + b, 0), 'duration');
  let t = 0;
  let worst = 0;
  for (let k = 0; k < p.idx.length; k++) {
    worst = Math.max(worst, diff(out.frames[at(out, t)], drawFrame(src, p, k)));
    t += p.delays[k];
  }
  return worst;
}
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

const results = [];
async function test(name, fn) {
  if (only && !only.test(name)) return;
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, note, s: (Date.now() - t0) / 1000 });
    console.log(`ok   ${name}${note ? `: ${note}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, note: e.message, s: (Date.now() - t0) / 1000 });
    console.log(`FAIL ${name}: ${e.stack}`);
  }
}
async function setRange(page, name, v) {
  await page.$eval(`[name=${name}]`, (e, v) => {
    e.value = v;
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
  }, String(v));
}

const film = decodeGif(read('film.gif'));
const sticker = decodeGif(read('sticker.gif'));
const clipOf = (g) => ({ w: g.width, h: g.height, frames: g.frames, delays: g.delays, loop: g.loopCount });

// ---- tests
await test('home page routes a GIF to the compressor and a video to video-to-GIF', async () => {
  let page = await open('/');
  await page.screenshot({ path: join(outDir, 'home.png'), fullPage: true });
  await upload(page, fx('film.gif'));
  await page.waitForURL(/\/compress\//);
  await loaded(page);
  assert.match(await page.textContent('.facts'), /film\.gif/);
  await page.close();
  page = await open('/');
  await upload(page, fx('clip.webm'));
  await page.waitForURL(/\/video-to-gif\//);
  await loaded(page);
  await page.close();
  page = await open('/');
  await upload(page, [fx('red.png'), fx('green.jpg')]);
  await page.waitForURL(/\/maker\//);
  await page.waitForSelector('.thumb');
  assert.equal(await page.$$eval('.thumb', (t) => t.length), 2);
  await page.close();
});

await test('compress: smaller, same timing, frames close to the source', async () => {
  const page = await open('/compress/');
  await upload(page, fx('film.gif'));
  await loaded(page);
  const { bytes, facts } = await run(page);
  await page.screenshot({ path: join(outDir, 'compress.png'), fullPage: true });
  const out = decodeGif(bytes);
  assert.ok(bytes.length < statSync(fx('film.gif')).size, 'output must be smaller');
  const worst = expectFrames(out, clipOf(film), []);
  await page.close();
  return `${kb(statSync(fx('film.gif')).size)} -> ${kb(bytes.length)}; max channel error ${worst}; ${facts.replace(/\s+/g, ' ').trim()}`;
});

if (existsSync(fx('real.gif'))) {
  await test('compress a real film GIF at the default and to a size limit', async () => {
    const size = statSync(fx('real.gif')).size;
    const page = await open('/compress/');
    await upload(page, fx('real.gif'));
    await loaded(page);
    const a = await run(page);
    await page.check('[name=useTarget]');
    const target = Math.round((size * 0.25) / 1024);
    await page.fill('[name=target]', String(target));
    await page.selectOption('[name=unit]', '1024');
    const b = await run(page, 400000);
    assert.ok(b.bytes.length <= target * 1024, `${b.bytes.length} > ${target * 1024}`);
    const g = decodeGif(b.bytes);
    assert.equal(dur(g), dur(decodeGif(read('real.gif'))));
    await page.close();
    return `${kb(size)} -> ${kb(a.bytes.length)} at quality 70; limit ${target} KB -> ${kb(b.bytes.length)} (${b.facts.match(/Quality: ([^T]*)/)?.[1]?.trim()})`;
  });
}

await test('compress: drop every 2nd frame keeps the length', async () => {
  const page = await open('/compress/');
  await upload(page, fx('film.gif'));
  await loaded(page);
  await page.click('label:has(input[name=drop][value="2"])');
  const { bytes } = await run(page);
  const out = decodeGif(bytes);
  expectFrames(out, clipOf(film), [{ type: 'drop', every: 2 }]);
  await page.close();
});

await test('loop setting is kept: plays-once stays once, forever stays forever', async () => {
  const page = await open('/compress/');
  await upload(page, fx('once.gif'));
  await loaded(page);
  const a = await run(page);
  assert.equal(parseGif(a.bytes).loopCount, null);
  await page.click('button:has-text("Use another file")');
  await upload(page, fx('sticker.gif'));
  await page.waitForFunction(() => document.querySelector('.facts')?.textContent.includes('sticker'));
  const b = await run(page);
  assert.equal(parseGif(b.bytes).loopCount, 0);
  // and it can be changed
  await page.click('summary');
  await page.selectOption('[name=loop]', 'n');
  await page.fill('[name=repeats]', '3');
  const c = await run(page);
  assert.equal(parseGif(c.bytes).loopCount, 3);
  await page.close();
});

await test('resize to 50% keeps transparency', async () => {
  const page = await open('/resize/');
  await upload(page, fx('sticker.gif'));
  await loaded(page);
  await page.click('[data-k="0.5"]');
  const { bytes } = await run(page);
  await page.screenshot({ path: join(outDir, 'resize.png'), fullPage: true });
  const out = decodeGif(bytes);
  assert.equal(out.width, 60);
  assert.equal(out.height, 48);
  assert.equal(out.frames[0][3], 0, 'top-left stays transparent');
  assert.equal(out.frames[0][(46 * 60 + 30) * 4 + 3], 255, 'the bar stays opaque');
  await page.close();
});

await test('crop is exact at quality 100', async () => {
  const page = await open('/crop/');
  await upload(page, fx('film.gif'));
  await loaded(page);
  await page.screenshot({ path: join(outDir, 'crop.png'), fullPage: true });
  for (const [k, v] of Object.entries({ x: 10, y: 20, w: 100, h: 80 })) {
    await page.fill(`[name=${k}]`, String(v));
    await page.$eval(`[name=${k}]`, (e) => e.dispatchEvent(new Event('change')));
  }
  const { bytes } = await run(page);
  const worst = expectFrames(decodeGif(bytes), clipOf(film), [{ type: 'crop', x: 10, y: 20, w: 100, h: 80 }]);
  assert.equal(worst, 0, `max channel error ${worst}`);
  await page.close();
});

await test('crop by dragging a square', async () => {
  const page = await open('/crop/');
  await upload(page, fx('sticker.gif'));
  await loaded(page);
  await page.click('label:has(input[name=ratio][value="1"])');
  const box = await page.$('[data-cropper] canvas');
  const r = await box.boundingBox();
  await page.mouse.move(r.x + 5, r.y + 5);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.6, r.y + r.height * 0.9, { steps: 5 });
  await page.mouse.up();
  const w = +(await page.inputValue('[name=w]'));
  const h = +(await page.inputValue('[name=h]'));
  assert.equal(w, h, 'square');
  const { bytes } = await run(page);
  const out = decodeGif(bytes);
  assert.equal(out.width, w);
  await page.close();
  return `${w}x${h}`;
});

await test('cut keeps frames 5 to 20 exactly, and removes them', async () => {
  const page = await open('/cut/');
  await upload(page, fx('film.gif'));
  await loaded(page);
  await page.waitForSelector('.frames button');
  await page.click('.frames button[data-i="5"]');
  await page.click('.frames button[data-i="20"]');
  await page.screenshot({ path: join(outDir, 'cut.png'), fullPage: true });
  let { bytes } = await run(page);
  let out = decodeGif(bytes);
  assert.equal(expectFrames(out, clipOf(film), [{ type: 'cut', from: 4, to: 19, mode: 'keep' }]), 0);
  await page.click('label:has(input[name=mode][value=remove])');
  ({ bytes } = await run(page));
  out = decodeGif(bytes);
  assert.equal(expectFrames(out, clipOf(film), [{ type: 'cut', from: 4, to: 19, mode: 'remove' }]), 0);
  await page.close();
});

await test('speed: 2x halves the length, 0.5x doubles it, fixed delay', async () => {
  const page = await open('/speed/');
  await upload(page, fx('film.gif'));
  await loaded(page);
  await page.click('[data-f="2"]');
  let out = decodeGif((await run(page)).bytes);
  assert.equal(expectFrames(out, clipOf(film), [{ type: 'speed', factor: 2 }]), 0);
  assert.ok(Math.abs(dur(out) - dur(film) / 2) <= 2, `${dur(out)} vs ${dur(film)}`);
  await page.click('[data-f="0.5"]');
  out = decodeGif((await run(page)).bytes);
  assert.equal(dur(out), dur(film) * 2);
  await page.click('label:has(input[name=mode][value=delay])');
  await page.fill('[name=ms]', '50');
  out = decodeGif((await run(page)).bytes);
  assert.equal(expectFrames(out, clipOf(film), [{ type: 'delay', cs: 5 }]), 0);
  await page.close();
});

await test('reverse and boomerang are exact', async () => {
  const page = await open('/reverse/');
  await upload(page, fx('sticker.gif'));
  await loaded(page);
  let out = decodeGif((await run(page)).bytes);
  assert.equal(expectFrames(out, clipOf(sticker), [{ type: 'reverse' }]), 0);
  await page.click('label:has(input[name=mode][value=boomerang])');
  out = decodeGif((await run(page)).bytes);
  assert.equal(expectFrames(out, clipOf(sticker), [{ type: 'reverse', boomerang: true }]), 0);
  await page.close();
});

await test('rotate 90 right and flip are exact', async () => {
  const page = await open('/rotate/');
  await upload(page, fx('sticker.gif'));
  await loaded(page);
  await page.click('label:has(input[name=deg][value="90"])');
  await page.check('[name=fh]');
  const out = decodeGif((await run(page)).bytes);
  assert.equal(expectFrames(out, clipOf(sticker), [{ type: 'rotate', deg: 90 }, { type: 'flip', h: true, v: false }]), 0);
  await page.close();
});

await test('video to GIF: 2 s at 10 fps, 320 px', async () => {
  const page = await open('/video-to-gif/');
  await upload(page, fx('clip.webm'));
  await loaded(page);
  await page.fill('[name=start]', '0');
  await page.fill('[name=end]', '2');
  await page.click('label:has(input[name=fps][value="10"])');
  await page.click('label:has(input[name=side][value="320"])');
  const { bytes, facts } = await run(page);
  await page.screenshot({ path: join(outDir, 'video.png'), fullPage: true });
  const out = decodeGif(bytes);
  assert.equal(out.width, 320);
  assert.equal(out.height, 180);
  assert.equal(dur(out), 200);
  await page.close();
  return facts.replace(/\s+/g, ' ').trim();
});

if (existsSync(fx('real.webm'))) {
  await test('video to GIF: 4 s of film at 15 fps, 480 px', async () => {
    const page = await open('/video-to-gif/');
    await upload(page, fx('real.webm'));
    await loaded(page);
    await page.fill('[name=end]', '4');
    const { bytes, facts } = await run(page);
    const out = decodeGif(bytes);
    assert.equal(out.width, 480);
    assert.equal(dur(out), 400);
    await page.close();
    return facts.replace(/\s+/g, ' ').trim();
  });
}

await test('images to GIF: three pictures of different shapes', async () => {
  const page = await open('/maker/');
  await upload(page, [fx('red.png'), fx('green.jpg'), fx('blue.webp')]);
  await page.waitForSelector('form.card:not([hidden])');
  await page.screenshot({ path: join(outDir, 'maker.png'), fullPage: true });
  const { bytes } = await run(page);
  const out = decodeGif(bytes);
  assert.equal(out.width, 300);
  assert.equal(out.height, 200);
  assert.deepEqual(out.delays, [20, 20, 20]);
  const mid = (f) => [...f.subarray((100 * 300 + 150) * 4, (100 * 300 + 150) * 4 + 4)];
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 12);
  assert.ok(near(mid(out.frames[0]), [200, 40, 40, 255]), `red ${mid(out.frames[0])}`);
  assert.ok(near(mid(out.frames[2]), [40, 60, 220, 255]), `blue ${mid(out.frames[2])}`);
  assert.equal(out.frames[1][3], 0, 'green.jpg is narrower, so the left edge is transparent');
  await page.close();
});

await test('a result can be passed on to another tool', async () => {
  const page = await open('/compress/');
  await upload(page, fx('sticker.gif'));
  await loaded(page);
  await run(page);
  await page.click('#result .next button:has-text("Resize")');
  await page.waitForURL(/\/resize\//);
  await loaded(page);
  assert.match(await page.textContent('.facts'), /sticker-small\.gif/);
  await page.close();
});

await test('download, about and privacy pages render', async () => {
  for (const p of ['/download/', '/about/', '/privacy/']) {
    const page = await open(p);
    await page.screenshot({ path: join(outDir, `${p.replace(/\//g, '') || 'home'}.png`), fullPage: true });
    if (p === '/download/') assert.equal(await page.$$eval('.dl a[href*="releases/latest/download/"]', (a) => a.length), 4);
    await page.close();
  }
});

await test('phone width: no sideways scrolling, ad preview slots show', async () => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  for (const p of ['/', '/compress/', '/video-to-gif/', '/crop/', '/download/']) {
    const page = await phone.newPage();
    page.on('pageerror', (e) => problems.push(`${p} (phone): ${e.message}`));
    await page.goto(base + p);
    if (p === '/compress/' || p === '/crop/') {
      await upload(page, fx('film.gif'));
      await loaded(page);
    }
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(sw <= 390, `${p}: page is ${sw}px wide`);
    await page.screenshot({ path: join(outDir, `phone-${p.replace(/\//g, '') || 'home'}.png`), fullPage: true });
    await page.close();
  }
  const page = await phone.newPage();
  await page.goto(`${base}/compress/?ads=preview`);
  assert.ok((await page.$$eval('.ad.preview', (a) => a.length)) >= 2);
  await page.close();
  const wide = await ctx.newPage();
  await wide.goto(`${base}/compress/?ads=preview`);
  await wide.screenshot({ path: join(outDir, 'ads-preview.png'), fullPage: true });
  await wide.close();
  await phone.close();
});

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
if (problems.length) console.log(`\nbrowser errors:\n  ${[...new Set(problems)].join('\n  ')}`);
console.log(`\n${results.length - failed.length} of ${results.length} passed${problems.length ? `, ${problems.length} browser errors` : ''}`);
writeFileSync(join(outDir, 'results.json'), JSON.stringify({ results, problems }, null, 1));
process.exit(failed.length || problems.length ? 1 : 0);
