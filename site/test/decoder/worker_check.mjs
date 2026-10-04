// Checks that gifdecode.js works inside a module worker in Chromium and that the frames it
// hands out can be transferred straight back to the page (they are caller-owned).
// usage: node worker_check.mjs [file.gif]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './lib/chromium.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(here, 'wikimedia/Sorting_quicksort_anim.gif');
const h = await launch();
const res = await h.page.evaluate(async (url) => {
  const src = `
    import { decodeGif, decodeFrames } from '${location.origin}/site/assets/gifdecode.js';
    onmessage = async (e) => { try {
      const bytes = new Uint8Array(await (await fetch(e.data)).arrayBuffer());
      const all = decodeGif(bytes);
      const sums = all.frames.map(f => { let s = 0; for (let i = 0; i < f.length; i += 97) s = (s * 31 + f[i]) >>> 0; return s; });
      const streamed = [];
      for (const fr of decodeFrames(bytes)) streamed.push(fr.rgba.buffer);
      postMessage({ n: all.frames.length, w: all.width, h: all.height, sums, buffers: streamed }, streamed);
    } catch (err) { postMessage({ error: String(err && err.stack || err) }); } };`;
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' });
  const out = await new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error('worker timed out')), 20000);
    w.onmessage = e => resolve(e.data);
    w.onerror = e => reject(new Error('worker error: ' + (e.message || 'module failed to load')));
    w.postMessage(new URL(url, location.href).href); // absolute: a blob: worker has no usable base URL
  });
  w.terminate();
  if (out.error) throw new Error(out.error);
  const GD = await import('/site/assets/gifdecode.js');
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const page = GD.decodeGif(bytes);
  let same = out.n === page.frames.length;
  for (let i = 0; same && i < out.n; i++) {
    const a = new Uint8Array(out.buffers[i]), b = page.frames[i];
    if (a.length !== b.length) same = false;
    else for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) { same = false; break; }
  }
  return { frames: out.n, size: `${out.w}x${out.h}`, transferred: out.buffers.length, matchesPage: same };
}, h.urlFor(file));
await h.close();
console.log(JSON.stringify(res));
if (!res.matchesPage) process.exit(1);
