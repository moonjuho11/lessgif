// Drives every page of the built site (site/dist) in Chromium and checks the GIFs it makes.
//   sh site/test/make-fixtures.sh && node site/build.mjs && node site/test/e2e.mjs
// Needs Playwright with Chromium (PLAYWRIGHT=<path to playwright/index.mjs> to use a global
// install). Screenshots go to site/test/out/. Playwright's Chromium can't encode H.264, so GIF to
// MP4 makes VP9 there; CHROME=<path to a Chrome or Chrome for Testing binary> tests H.264 too.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
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

// ---- static server, sending the headers Cloudflare would send (from dist/_headers)
function headerRules(text) {
  const rules = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (!/^\s/.test(line)) rules.push({ re: new RegExp(`^${line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`), headers: [] });
    else rules.at(-1).headers.push([line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(':') + 1).trim()]);
  }
  return (path) => Object.fromEntries(rules.filter((r) => r.re.test(path)).flatMap((r) => r.headers));
}
const headersFor = headerRules(readFileSync(join(dist, '_headers'), 'utf8'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.xml': 'application/xml', '.txt': 'text/plain', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let p = url;
  if (p.endsWith('/')) p += 'index.html';
  const f = join(dist, p);
  if (!f.startsWith(dist) || !existsSync(f) || statSync(f).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream', ...headersFor(url) }).end(readFileSync(f));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
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
  // download the result the way a visitor does (the page's policy doesn't let scripts fetch it)
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#result a[download]')]);
  const facts = await page.$eval('#result .facts', (e) => e.textContent);
  return { bytes: new Uint8Array(readFileSync(await download.path())), facts };
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

// The files in a ZIP whose entries are stored (method 0), from its central directory.
function unzip(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let e = b.length - 22;
  while (v.getUint32(e, true) !== 0x06054b50) e--;
  const files = [];
  for (let k = 0, o = v.getUint32(e + 16, true); k < v.getUint16(e + 10, true); k++) {
    assert.equal(v.getUint32(o, true), 0x02014b50);
    assert.equal(v.getUint16(o + 10, true), 0, 'stored');
    const size = v.getUint32(o + 20, true);
    const nameLen = v.getUint16(o + 28, true);
    const name = new TextDecoder().decode(b.subarray(o + 46, o + 46 + nameLen));
    const at = v.getUint32(o + 42, true);
    const data = b.subarray(at + 30 + v.getUint16(at + 26, true) + v.getUint16(at + 28, true));
    files.push({ name, data: data.subarray(0, size), crc: v.getUint32(o + 16, true) });
    o += 46 + nameLen + v.getUint16(o + 30, true) + v.getUint16(o + 32, true);
  }
  return files;
}

// An 8-bit RGB or RGBA PNG (what browsers write) as RGBA.
function decodePng(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let w, h, type;
  const idat = [];
  for (let o = 8; o < b.length; ) {
    const len = v.getUint32(o);
    const t = String.fromCharCode(...b.subarray(o + 4, o + 8));
    if (t === 'IHDR') {
      [w, h, type] = [v.getUint32(o + 8), v.getUint32(o + 12), b[o + 17]];
      assert.equal(b[o + 16], 8, 'bit depth');
      assert.equal(b[o + 20], 0, 'not interlaced');
    } else if (t === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len));
    o += len + 12;
  }
  const ch = { 2: 3, 6: 4 }[type];
  assert.ok(ch, `PNG colour type ${type}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[y * stride + x - ch] : 0;
      const up = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= ch && y ? px[(y - 1) * stride + x - ch] : 0;
      const pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c);
      const pred = [0, a, up, (a + up) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? up : c][f];
      px[y * stride + x] = (line[x] + pred) & 255;
    }
  }
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba.set(px.subarray(i * ch, i * ch + 3), i * 4);
    rgba[i * 4 + 3] = ch === 4 ? px[i * ch + 3] : 255;
  }
  return { w, h, rgba };
}

// The boxes of an MP4 file as { type: [payload, ...] }, nested for the container boxes.
function mp4Boxes(b, from = 0, to = b.length) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = {};
  for (let o = from; o < to; ) {
    const size = v.getUint32(o);
    const type = String.fromCharCode(...b.subarray(o + 4, o + 8));
    assert.ok(size >= 8 && o + size <= to, `box ${type} of ${size} bytes at ${o}`);
    const body = ['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type) ? mp4Boxes(b, o + 8, o + size) : b.subarray(o + 8, o + size);
    (out[type] ??= []).push(body);
    o += size;
  }
  return out;
}

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

await test('add text: shows on the chosen frames only, where it was dragged', async () => {
  const page = await open('/add-text/');
  await upload(page, fx('film.gif'));
  await loaded(page);
  await page.fill('[name=text]', 'hello');
  assert.equal(await page.textContent('[data-layers]'), 'Text 1: hello+ Add another text');
  await page.fill('[name=last]', '30');
  await page.$eval('[name=last]', (e) => e.dispatchEvent(new Event('input')));
  await page.click('button:has-text("Add another text")');
  await page.fill('[name=text]', 'bye');
  await page.fill('[name=first]', '31');
  await page.$eval('[name=first]', (e) => e.dispatchEvent(new Event('input')));
  // drag "bye" from the bottom to the top left corner
  const r = await (await page.$('[data-texter] canvas')).boundingBox();
  const sel = await (await page.$('[data-texter] .tsel')).boundingBox();
  await page.$eval('[name=at]', (e) => {
    e.value = 40;
    e.dispatchEvent(new Event('input'));
  });
  await page.mouse.move(sel.x + sel.width / 2, sel.y + sel.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.15, r.y + r.height * 0.15, { steps: 5 });
  await page.mouse.up();
  await page.screenshot({ path: join(outDir, 'add-text.png'), fullPage: true });
  const { bytes } = await run(page);
  const out = decodeGif(bytes);
  assert.equal(out.width, film.width);
  assert.equal(dur(out), dur(film));
  // where each output frame differs a lot from the source: the text
  const box = (k) => {
    const a = out.frames[at(out, film.delays.slice(0, k).reduce((x, y) => x + y, 0))];
    const b = film.frames[k];
    let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const i = (y * out.width + x) * 4;
        if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) < 90) continue;
        n++;
        [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
      }
    }
    return { n, x0, y0, x1, y1 };
  };
  const first = box(10);
  const second = box(45);
  assert.ok(first.n > 150, `text 1 changed ${first.n} pixels`);
  assert.ok(first.y1 < out.height / 2 && Math.abs((first.x0 + first.x1) / 2 - out.width / 2) < 12, `text 1 is centred at the top: ${JSON.stringify(first)}`);
  assert.ok(second.n > 100 && second.x1 < out.width * 0.4 && second.y1 < out.height * 0.4, `text 2 was dragged to the top left: ${JSON.stringify(second)}`);
  await page.close();
  return `text 1 at ${first.x0},${first.y0}-${first.x1},${first.y1}; text 2 at ${second.x0},${second.y0}-${second.x1},${second.y1}`;
});

await test('split: a ZIP of PNGs with exactly the frames, or one JPG', async () => {
  const page = await open('/split/');
  await upload(page, fx('sticker.gif'));
  await loaded(page);
  await page.screenshot({ path: join(outDir, 'split.png'), fullPage: true });
  const { bytes, facts } = await run(page);
  const files = unzip(bytes);
  assert.equal(files.length, sticker.frames.length);
  files.forEach((f, i) => {
    assert.equal(f.name, `sticker-${String(i + 1).padStart(3, '0')}.png`);
    const png = decodePng(f.data);
    assert.equal(png.w, sticker.width);
    assert.equal(diff(png.rgba, sticker.frames[i]), 0, f.name);
  });
  await page.fill('[name=from]', '2');
  await page.fill('[name=to]', '3');
  await page.click('label:has(input[name=format][value=jpg])');
  const jpg = unzip((await run(page)).bytes);
  assert.deepEqual(jpg.map((f) => f.name), ['sticker-002.jpg', 'sticker-003.jpg']);
  assert.deepEqual([...jpg[0].data.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  await page.close();
  return facts.replace(/\s+/g, ' ').trim();
});

await test('GIF to MP4: every frame with its timing, even size, plays back', async () => {
  const page = await open('/gif-to-mp4/');
  const notes = [];
  for (const [name, g, rep] of [['film.gif', film, 1], ['odd.gif', decodeGif(read('odd.gif')), 2]]) {
    if (name !== 'film.gif') await page.click('button:has-text("Use another file")');
    await upload(page, fx(name));
    await page.waitForFunction((n) => document.querySelector('.facts')?.textContent.includes(n), name);
    await page.click(`label:has(input[name=repeat][value="${rep}"])`);
    const { bytes, facts } = await run(page);
    if (name === 'film.gif') await page.screenshot({ path: join(outDir, 'gif-to-mp4.png'), fullPage: true });
    assert.doesNotMatch(await page.textContent('#result'), /null|undefined/);
    const top = mp4Boxes(bytes);
    assert.deepEqual(Object.keys(top), ['ftyp', 'moov', 'mdat']);
    const stbl = top.moov[0].trak[0].mdia[0].minf[0].stbl[0];
    const dv = (u) => new DataView(u.buffer, u.byteOffset, u.byteLength);
    const stts = dv(stbl.stts[0]);
    const durs = [];
    for (let k = 0; k < stts.getUint32(4); k++) for (let j = 0; j < stts.getUint32(8 + k * 8); j++) durs.push(stts.getUint32(12 + k * 8));
    const want = Array(rep).fill(g.delays).flat().map((d) => d * 10);
    assert.deepEqual(durs, want, 'one sample per frame, each as long as the frame');
    const entry = stbl.stsd[0].subarray(8);
    const codec = String.fromCharCode(...entry.subarray(4, 8));
    const ew = dv(entry).getUint16(32);
    const eh = dv(entry).getUint16(34);
    assert.deepEqual([ew, eh], [g.width + (g.width & 1), g.height + (g.height & 1)]);
    const sizes = dv(stbl.stsz[0]);
    let total = 0;
    for (let k = 0; k < sizes.getUint32(8); k++) total += sizes.getUint32(12 + k * 4);
    assert.equal(total, top.mdat[0].length, 'the sample sizes add up to the data');
    assert.equal(dv(stbl.stco[0]).getUint32(8), bytes.length - top.mdat[0].length, 'the chunk offset points at the data');
    const played = await page.$eval('#result video', async (v) => {
      if (v.readyState < 2) await new Promise((ok) => ((v.onloadeddata = ok), (v.onerror = ok), setTimeout(ok, 5000)));
      return { w: v.videoWidth, h: v.videoHeight, d: v.duration, error: v.error?.code ?? null };
    });
    if (codec === 'vp09' || process.env.CHROME) {
      assert.equal(played.error, null, `the browser can't play it: ${JSON.stringify(played)}`);
      assert.deepEqual([played.w, played.h], [ew, eh]);
      assert.ok(Math.abs(played.d - durs.reduce((a, b) => a + b, 0) / 1000) < 0.01, `duration ${played.d}`);
    }
    notes.push(`${name} -> ${codec} ${ew}x${eh}, ${kb(bytes.length)}`);
    if (name === 'film.gif') notes.push(facts.match(/Size: [^)]*\)/)?.[0]);
  }
  await page.close();
  return notes.join('; ');
});

await test("only the site's own code runs, nothing is sent elsewhere, and no other site can frame it", async () => {
  const page = await ctx.newPage(); // not open(): the blocked attempts below log console errors on purpose
  const res = await page.goto(`${base}/compress/`);
  const h = res.headers();
  assert.match(h['content-security-policy'], /script-src 'self' 'wasm-unsafe-eval';.*frame-ancestors 'none'$/);
  assert.equal(h['x-frame-options'], 'DENY');
  assert.match(h['strict-transport-security'], /^max-age=31536000/);
  assert.equal(await page.$eval('meta[http-equiv=Content-Security-Policy]', (m) => m.content), h['content-security-policy'].replace(/; frame-ancestors 'none'$/, ''));
  const blocked = await page.evaluate(async () => {
    const seen = [];
    document.addEventListener('securitypolicyviolation', (e) => seen.push(e.effectiveDirective));
    const inline = document.createElement('script');
    inline.textContent = 'window.inlineRan = true';
    document.head.append(inline);
    const outside = document.createElement('script');
    outside.src = 'https://example.com/x.js';
    document.head.append(outside);
    await fetch('https://example.com/collect', { method: 'POST', body: 'x' }).catch(() => {});
    await new Promise((ok) => setTimeout(ok, 200));
    return { inlineRan: !!window.inlineRan, seen: [...new Set(seen)].sort() };
  });
  assert.deepEqual(blocked, { inlineRan: false, seen: ['connect-src', 'script-src-elem'] });
  await page.setContent(`<iframe src="${base}/compress/"></iframe>`);
  await page.waitForTimeout(1000);
  assert.equal(await page.frames()[1]?.$('header.top').catch(() => null) ?? null, null, 'the site showed inside another page');
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
  for (const p of ['/', '/compress/', '/video-to-gif/', '/crop/', '/add-text/', '/split/', '/gif-to-mp4/', '/download/']) {
    const page = await phone.newPage();
    page.on('pageerror', (e) => problems.push(`${p} (phone): ${e.message}`));
    await page.goto(base + p);
    if (['/compress/', '/crop/', '/add-text/', '/split/', '/gif-to-mp4/'].includes(p)) {
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
