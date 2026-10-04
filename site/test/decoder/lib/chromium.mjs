// Shared harness plumbing: a static file server rooted at the scratch root plus a Chromium page.
// The page is served from http://127.0.0.1:<port>/__harness.html (a secure context, so
// WebCodecs ImageDecoder is available) and can import /site/assets/gifdecode.js.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// /site/... is served from the site directory this harness lives in; /abs/<absolute path> serves
// any local file (the server only listens on 127.0.0.1).
export const SITE = path.resolve(here, '../../..');
const PW = '/opt/node22/lib/node_modules/playwright/index.mjs';

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.gif': 'image/gif', '.html': 'text/html', '.json': 'application/json' };

export function startServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/__harness.html') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8"><title>harness</title><body></body>');
      return;
    }
    const pn = decodeURIComponent(u.pathname);
    let p;
    if (pn.startsWith('/abs/')) p = path.resolve(pn.slice(4));
    else if (pn.startsWith('/site/')) p = path.join(SITE, pn.slice(6));
    else { res.writeHead(404); res.end(); return; }
    if (pn.includes('..')) { res.writeHead(403); res.end(); return; }
    fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

export async function launch() {
  const { chromium } = await import(PW);
  let browser;
  try { browser = await chromium.launch(); }
  catch (e) { browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }); }
  const { server, port } = await startServer();
  const page = await browser.newPage();
  page.on('console', m => { if (process.env.HARNESS_CONSOLE) console.error('[page]', m.text()); });
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  await page.goto(`http://127.0.0.1:${port}/__harness.html`);
  const close = async () => { await browser.close(); server.close(); };
  return { browser, page, port, close, urlFor: f => '/abs' + path.resolve(f).split(path.sep).map(encodeURIComponent).join('/') };
}

// In-page helper source (installed once per page): decode with ImageDecoder sequentially.
export const PAGE_HELPERS = `
window.chromeDecodeAll = async function (bytes, { keepPixels = true, maxFrames = 1e9 } = {}) {
  const out = { frameCount: null, repetitionCount: null, width: null, height: null, frames: [], error: null, errorAt: null };
  let dec;
  try {
    dec = new ImageDecoder({ data: bytes, type: 'image/gif' });
    await dec.tracks.ready;
    const tr = dec.tracks.selectedTrack;
    out.frameCount = tr.frameCount;
    out.repetitionCount = tr.repetitionCount;
  } catch (e) {
    out.error = String(e && e.message || e); out.errorAt = 'open';
    try { dec && dec.close(); } catch {}
    return out;
  }
  const n = Math.min(out.frameCount, maxFrames);
  let canvas = null, ctx = null;
  for (let i = 0; i < n; i++) {
    let r, partial = false, err = null;
    try { r = await dec.decode({ frameIndex: i }); }
    catch (e) {
      err = String(e && e.message || e);
      try { r = await dec.decode({ frameIndex: i, completeFramesOnly: false }); partial = true; }
      catch (e2) { r = null; }
    }
    if (!r) { out.frames.push({ error: err, rgba: null }); if (dec.closed !== undefined && dec.type === undefined) break; continue; }
    const im = r.image;
    const w = im.displayWidth, h = im.displayHeight;
    out.width = w; out.height = h;
    const f = { duration: im.duration, complete: r.complete, w, h, error: err, partial };
    if (keepPixels) {
      if (!canvas || canvas.width !== w || canvas.height !== h) {
        canvas = new OffscreenCanvas(w, h); ctx = canvas.getContext('2d', { willReadFrequently: true });
      }
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(im, 0, 0);
      f.rgba = ctx.getImageData(0, 0, w, h).data;
    }
    im.close();
    out.frames.push(f);
  }
  // Frame count may change after decoding (it is reported from what was parsed).
  try { out.frameCountAfter = dec.tracks.selectedTrack.frameCount; } catch {}
  dec.close();
  return out;
};
`;
