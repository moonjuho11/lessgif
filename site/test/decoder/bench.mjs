// Speed benchmark: megapixels of composited RGBA output per second.
//   node      : decodeGif() and the decodeFrames() generator in Node
//   chromium  : decodeGif() on the page's main thread, and WebCodecs ImageDecoder decoding every
//               frame in order (decode only, and decode + copyTo() into an RGBA buffer, which is
//               the closest equivalent of what decodeGif returns)
// usage: node bench.mjs [--runs N] [--no-chrome] [files...]   (default: a fixed set of big GIFs)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeGif, decodeFrames, parseGif } from '../../assets/gifdecode.js';
import { launch } from './lib/chromium.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, process.env.GIF_ROOT || '../../../../gif');
const DEFAULT = [
  'corpus/gifs/xiph_harbour_cif_0__ffbayer.gif',
  'corpus/gifs/xiph_husky_cif_1__ffpal.gif',
  'corpus/gifs/xiph_bus_cif_0__ffpal.gif',
  'corpus/gifs/xiph_husky_cif_1__gifski.gif',
  'corpus/gifs/screen_code_dark__ffbayer.gif',
  'corpus/gifs/screen_webpage__ffbayer.gif',
  'corpus/gifs/screen_slides__ffpal.gif',
  'Newtons_cradle_animation_book_2.gif',
  'Rotating_earth_%28large%29.gif',
].map(f => path.join(ROOT, f)).concat([path.join(here, 'wikimedia/Sorting_quicksort_anim.gif')]);

const args = process.argv.slice(2);
let runs = 5, chrome = true;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--runs') runs = +args[++i];
  else if (args[i] === '--no-chrome') chrome = false;
  else files.push(args[i]);
}
const list = files.length ? files : DEFAULT;

function median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }
const fmt = (mp, ms) => (mp / (ms / 1000)).toFixed(0).padStart(5);

const rows = [];
for (const f of list) {
  const bytes = new Uint8Array(fs.readFileSync(f));
  const g = parseGif(bytes);
  const mp = g.width * g.height * g.frames.length / 1e6;
  const row = { file: path.basename(f), kb: Math.round(bytes.length / 1024), w: g.width, h: g.height, frames: g.frames.length, mp };
  decodeGif(bytes); // warm up
  const t1 = [], t2 = [];
  for (let r = 0; r < runs; r++) {
    let t = performance.now(); decodeGif(bytes); t1.push(performance.now() - t);
    t = performance.now(); for (const fr of decodeFrames(bytes)) { void fr; } t2.push(performance.now() - t);
  }
  row.node = median(t1); row.nodeGen = median(t2);
  rows.push(row);
}

if (chrome) {
  const h = await launch();
  await h.page.evaluate(`import('/site/assets/gifdecode.js').then(m => { window.GD = m; })`);
  await h.page.waitForFunction(() => !!window.GD);
  for (const [k, f] of list.entries()) {
    const res = await h.page.evaluate(async ({ url, runs }) => {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
      async function chromeAll(copy) {
        const t = performance.now();
        const dec = new ImageDecoder({ data: bytes, type: 'image/gif' });
        await dec.tracks.ready;
        const n = dec.tracks.selectedTrack.frameCount;
        let buf = null;
        for (let i = 0; i < n; i++) {
          const { image } = await dec.decode({ frameIndex: i });
          if (copy) {
            const opts = { format: 'RGBA' };
            if (!buf) buf = new Uint8Array(image.allocationSize(opts));
            await image.copyTo(buf, opts);
          }
          image.close();
        }
        dec.close();
        return performance.now() - t;
      }
      window.GD.decodeGif(bytes); await chromeAll(false); // warm up
      const ours = [], cd = [], cc = [];
      for (let r = 0; r < runs; r++) {
        let t = performance.now(); window.GD.decodeGif(bytes); ours.push(performance.now() - t);
        cd.push(await chromeAll(false));
        cc.push(await chromeAll(true));
      }
      return { ours: med(ours), chromeDecode: med(cd), chromeCopy: med(cc) };
    }, { url: h.urlFor(f), runs });
    Object.assign(rows[k], { pageOurs: res.ours, chromeDecode: res.chromeDecode, chromeCopy: res.chromeCopy });
  }
  await h.close();
}

console.log(`median of ${runs} runs; MP/s = output megapixels (width x height x frames) per second\n`);
console.log('file'.padEnd(36) + '   KB   size     fr     MP |  node  nodeGen | page-ours  IDec  IDec+copy');
for (const r of rows) {
  console.log(r.file.slice(0, 36).padEnd(36) + String(r.kb).padStart(6) + ` ${r.w}x${r.h}`.padEnd(10) + String(r.frames).padStart(4) + r.mp.toFixed(1).padStart(7) +
    ' | ' + fmt(r.mp, r.node) + '  ' + fmt(r.mp, r.nodeGen) + '   ' +
    (r.pageOurs !== undefined ? '|   ' + fmt(r.mp, r.pageOurs) + '   ' + fmt(r.mp, r.chromeDecode) + '   ' + fmt(r.mp, r.chromeCopy) : ''));
}
const tot = k => rows.reduce((s, r) => s + r[k], 0);
const mpT = rows.reduce((s, r) => s + r.mp, 0);
console.log('TOTAL'.padEnd(63) + mpT.toFixed(1).padStart(4) + ' | ' + fmt(mpT, tot('node')) + '  ' + fmt(mpT, tot('nodeGen')) + '   ' +
  (rows[0].pageOurs !== undefined ? '|   ' + fmt(mpT, tot('pageOurs')) + '   ' + fmt(mpT, tot('chromeDecode')) + '   ' + fmt(mpT, tot('chromeCopy')) : ''));
