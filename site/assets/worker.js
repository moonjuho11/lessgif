// The site's worker: decodes GIFs and runs edits and the encoder off the main thread.
//
// Messages in: { id, type: 'decode', bytes: ArrayBuffer }
//              { id, type: 'encode', clip: { w, h, frames: [ArrayBuffer], delays, loop }, ops, out }
//   out: { quality } or { targetBytes }, plus optional colors (2-255), dither (0-1), loop
// Messages out: { id, progress: { text, done, total } } while working, then { id, result } or
// { id, error }. Frame buffers are transferred in and handed back with the result, so the page
// can run another edit without decoding again.
import { loadLessGif } from './lessgif.js';
import { plan, drawFrame } from './ops.js';
import { resize } from './resample.js';

let gz;
const encoder = () => (gz ??= loadLessGif(new URL('./lessgif.wasm', import.meta.url)));
encoder().catch(() => (gz = null)); // start compiling while the page is still being used

function progressFor(id) {
  let last = 0;
  return (text, done = 0, total = 0, force = false) => {
    const now = performance.now();
    if (!force && now - last < 60 && done < total) return;
    last = now;
    postMessage({ id, progress: { text, done, total } });
  };
}

const kb = (n) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

onmessage = async ({ data: m }) => {
  const progress = progressFor(m.id);
  let back = [];
  try {
    if (m.type === 'decode') {
      progress('Reading the GIF', 0, 0, true);
      const { decodeGif, parseGif } = await import('./gifdecode.js');
      const info = parseGif(new Uint8Array(m.bytes));
      const n = info.frames.length;
      if (m.budget && info.width * info.height * n > m.budget) {
        const mb = Math.round((info.width * info.height * n * 4) / 1e6);
        throw new Error(`This GIF has ${n} frames at ${info.width}x${info.height}, which needs about ${mb} MB of memory to edit, more than this device should use. The lessgif app can handle it.`);
      }
      const r = decodeGif(new Uint8Array(m.bytes), { onFrame: (i) => progress(`Reading frame ${i + 1} of ${n}`, i + 1, n) });
      const buffers = r.frames.map((f) => f.buffer);
      postMessage(
        { id: m.id, result: { w: r.width, h: r.height, frames: buffers, delays: r.delays, rawDelays: r.rawDelays, loop: r.loopCount, warnings: r.warnings } },
        buffers,
      );
      return;
    }
    if (m.type !== 'encode') throw new Error(`unknown job ${m.type}`);
    back = m.clip.frames;
    const t0 = performance.now();
    const clip = { ...m.clip, frames: m.clip.frames.map((b) => new Uint8ClampedArray(b)) };
    const p = plan(clip, m.ops || []);
    const n = p.idx.length;
    const out = m.out || {};
    const lib = await encoder();

    // draw the edited frames once (just references when no picture operation applies)
    let frames = [];
    for (let k = 0; k < n; k++) {
      frames.push(p.draw.length ? drawFrame(clip, p, k) : clip.frames[p.idx[k]]);
      if (p.draw.length) progress('Editing frames', k + 1, n);
    }
    const loop = out.loop !== undefined ? out.loop : p.loop;
    const settings = { colors: out.colors ?? 255, dither: out.dither ?? 0.75, loop: loop === null ? -1 : loop };
    const run = (fr, w, h, quality, label) =>
      lib.encode({
        w,
        h,
        n,
        getFrame: (i) => fr[i],
        delays: p.delays,
        quality,
        ...settings,
        onProgress: (d, t) => progress(label, d, t),
      });

    let result;
    if (out.targetBytes) {
      const search = lib.sizeSearch(out.targetBytes);
      let best = null;
      let scaled = { scale: 1, frames, w: p.w, h: p.h };
      try {
        let tries = 0;
        for (let a; (a = search.next()); ) {
          tries++;
          if (a.scale !== scaled.scale) {
            const w = Math.max(1, Math.round(p.w * a.scale));
            const h = Math.max(1, Math.round(p.h * a.scale));
            scaled = { scale: a.scale, frames: [], w, h };
            for (let k = 0; k < n; k++) {
              scaled.frames.push(resize(frames[k], p.w, p.h, w, h));
              progress(`Shrinking to ${w}x${h}`, k + 1, n);
            }
          }
          const size = a.scale < 1 ? ` at ${scaled.w}x${scaled.h}` : '';
          const r = run(scaled.frames, scaled.w, scaled.h, a.quality, `Try ${tries}: quality ${a.quality}${size}`);
          search.report(r.gif.length);
          progress(`Try ${tries}: quality ${a.quality}${size} gave ${kb(r.gif.length)}`, 1, 1, true);
          const b = search.best();
          if (b && b.quality === a.quality && b.scale === a.scale) best = { ...r, quality: a.quality, scale: a.scale, w: scaled.w, h: scaled.h };
        }
      } finally {
        search.close();
      }
      if (!best) throw new Error(`Couldn't get this GIF under ${kb(out.targetBytes)}, even at a tenth of its size. Try a larger size limit, or cut it shorter first.`);
      result = best;
    } else {
      const r = run(frames, p.w, p.h, out.quality ?? 70, 'Encoding');
      result = { ...r, quality: out.quality ?? 70, scale: 1, w: p.w, h: p.h };
    }
    frames = null;
    const gif = result.gif.buffer;
    postMessage(
      {
        id: m.id,
        result: {
          gif,
          w: result.w,
          h: result.h,
          n,
          framesWritten: result.framesWritten,
          duration: p.delays.reduce((a, b) => a + b, 0),
          quality: result.quality,
          scale: result.scale,
          loop,
          ms: performance.now() - t0, // edits and every size-search try included
          frames: back,
        },
      },
      [gif, ...back],
    );
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    // hand the frames back so the page can try again with other settings
    try {
      postMessage({ id: m.id, error: msg, frames: back }, back);
    } catch {
      postMessage({ id: m.id, error: msg });
    }
  }
};
