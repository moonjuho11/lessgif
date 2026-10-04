// Module worker: encodes frames with lessgif off the main thread.
//   in:  { w, h, frames: [ArrayBuffer RGBA], delays: [cs], quality }
//   out: { gif: ArrayBuffer, ms, framesWritten } or { error }
import { loadLessGif } from './lessgif.js';

const ready = loadLessGif();

onmessage = async ({ data: m }) => {
  try {
    const gz = await ready;
    const frames = m.frames.map((b) => new Uint8Array(b));
    const r = gz.encode({ w: m.w, h: m.h, n: frames.length, getFrame: (i) => frames[i], delays: m.delays, quality: m.quality });
    postMessage({ gif: r.gif.buffer, ms: r.ms, framesWritten: r.framesWritten }, [r.gif.buffer]);
  } catch (e) {
    postMessage({ error: String(e && e.message ? e.message : e) });
  }
};
