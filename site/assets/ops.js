// Edits on a clip: { w, h, frames: [Uint8ClampedArray w*h*4], delays: [centiseconds], loop }.
// loop is what the GIF stores: 0 repeats forever, n repeats n times, null plays once.
//
// Timing operations (cut, speed, reverse, drop) choose and re-time frames without touching
// pixels; picture operations (crop, resize, rotate, flip) change every frame. An operation list
// is turned into a plan (which source frame goes where, with what delay, at what size), and
// planned frames are drawn one at a time, so a long GIF never needs two full copies in memory
// unless the picture really changes.
import { resize } from './resample.js';

export const MIN_DELAY = 2; // browsers play anything shorter as 10 cs

// Re-times frames to play `factor` times as fast. A frame that would be shown for less than
// 2 cs is dropped and the next one starts earlier, so the total duration stays right.
function retime(idx, delays, factor) {
  const oi = [];
  const od = [];
  let t = 0;
  let start = 0;
  for (let k = 0; k < idx.length; k++) {
    t += delays[k];
    const end = Math.round(t / factor);
    const last = k === idx.length - 1;
    if (end - start >= MIN_DELAY || last) {
      if (last && end - start < MIN_DELAY && od.length) {
        od[od.length - 1] += end - start; // too short to show: give its time to the previous frame
      } else {
        oi.push(idx[k]);
        od.push(Math.max(MIN_DELAY, end - start));
      }
      start = end;
    }
  }
  return [oi, od];
}

export function plan(clip, ops) {
  let idx = clip.frames.map((_, i) => i);
  let delays = clip.delays.slice();
  let loop = clip.loop;
  let w = clip.w;
  let h = clip.h;
  const draw = []; // picture operations in order, each with the size it starts from
  for (const op of ops) {
    switch (op.type) {
      case 'cut': {
        // keep (or remove) frames from..to, inclusive, counted from 0
        const from = Math.max(0, op.from);
        const to = Math.min(idx.length - 1, op.to);
        if (!(from <= to)) throw new Error('The start frame must come before the end frame.');
        const inside = (k) => k >= from && k <= to;
        const keep = idx.map((_, k) => (op.mode === 'remove' ? !inside(k) : inside(k)));
        if (!keep.some(Boolean)) throw new Error('That would remove every frame.');
        idx = idx.filter((_, k) => keep[k]);
        delays = delays.filter((_, k) => keep[k]);
        break;
      }
      case 'speed':
        [idx, delays] = retime(idx, delays, op.factor);
        break;
      case 'delay':
        delays = delays.map(() => Math.max(MIN_DELAY, Math.round(op.cs)));
        break;
      case 'drop': {
        // keep every n-th frame; it is shown for the time of the frames dropped after it
        const n = Math.max(1, Math.round(op.every));
        const oi = [];
        const od = [];
        for (let k = 0; k < idx.length; k += n) {
          oi.push(idx[k]);
          od.push(delays.slice(k, k + n).reduce((a, b) => a + b, 0));
        }
        [idx, delays] = [oi, od];
        break;
      }
      case 'reverse':
        if (op.boomerang) {
          // forwards, then backwards without repeating the two end frames
          const back = idx.slice(1, -1).reverse();
          const backD = delays.slice(1, -1).reverse();
          idx = idx.concat(back);
          delays = delays.concat(backD);
        } else {
          idx = idx.slice().reverse();
          delays = delays.slice().reverse();
        }
        break;
      case 'loop':
        loop = op.count;
        break;
      case 'crop': {
        const x = Math.max(0, Math.round(op.x));
        const y = Math.max(0, Math.round(op.y));
        const cw = Math.min(w - x, Math.round(op.w));
        const ch = Math.min(h - y, Math.round(op.h));
        if (!(cw > 0 && ch > 0)) throw new Error('The crop area is empty.');
        draw.push({ type: 'crop', x, y, w: cw, h: ch, from: [w, h] });
        [w, h] = [cw, ch];
        break;
      }
      case 'resize': {
        const nw = Math.max(1, Math.round(op.w));
        const nh = Math.max(1, Math.round(op.h));
        if (nw !== w || nh !== h) draw.push({ type: 'resize', w: nw, h: nh, from: [w, h] });
        [w, h] = [nw, nh];
        break;
      }
      case 'rotate': {
        const turns = ((Math.round(op.deg / 90) % 4) + 4) % 4;
        if (turns) draw.push({ type: 'rotate', turns, from: [w, h] });
        if (turns % 2) [w, h] = [h, w];
        break;
      }
      case 'flip':
        if (op.h || op.v) draw.push({ type: 'flip', h: !!op.h, v: !!op.v, from: [w, h] });
        break;
      default:
        throw new Error(`unknown operation ${op.type}`);
    }
  }
  if (w > 65535 || h > 65535) throw new Error('GIF images can be at most 65535 pixels wide or tall.');
  return { idx, delays, loop, w, h, draw };
}

function crop(src, sw, x, y, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) out.set(src.subarray(((y + r) * sw + x) * 4, ((y + r) * sw + x + w) * 4), r * w * 4);
  return out;
}

function rotate(src, w, h, turns) {
  const s32 = new Uint32Array(src.buffer, src.byteOffset, w * h);
  const out = new Uint8ClampedArray(w * h * 4);
  const o32 = new Uint32Array(out.buffer);
  if (turns === 2) {
    for (let i = 0, n = w * h; i < n; i++) o32[n - 1 - i] = s32[i];
    return out;
  }
  // output is h wide and w tall
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = s32[y * w + x];
      if (turns === 1) o32[x * h + (h - 1 - y)] = v; // clockwise
      else o32[(w - 1 - x) * h + y] = v;
    }
  }
  return out;
}

function flip(src, w, h, fh, fv) {
  const s32 = new Uint32Array(src.buffer, src.byteOffset, w * h);
  const out = new Uint8ClampedArray(w * h * 4);
  const o32 = new Uint32Array(out.buffer);
  for (let y = 0; y < h; y++) {
    const sy = fv ? h - 1 - y : y;
    for (let x = 0; x < w; x++) o32[y * w + x] = s32[sy * w + (fh ? w - 1 - x : x)];
  }
  return out;
}

// Frame k of a plan. Returns the source frame itself when no picture operation applies.
export function drawFrame(clip, p, k) {
  let f = clip.frames[p.idx[k]];
  for (const d of p.draw) {
    const [w, h] = d.from;
    if (d.type === 'crop') f = crop(f, w, d.x, d.y, d.w, d.h);
    else if (d.type === 'resize') f = resize(f, w, h, d.w, d.h);
    else if (d.type === 'rotate') f = rotate(f, w, h, d.turns);
    else if (d.type === 'flip') f = flip(f, w, h, d.h, d.v);
  }
  return f;
}

// Size that fits inside max x max (never enlarges).
export function fit(w, h, max) {
  const k = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}
