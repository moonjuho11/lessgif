// Unit tests for the site's frame edits, resizer and GIF reader: node site/test/unit.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { plan, drawFrame } from '../assets/ops.js';
import { resize } from '../assets/resample.js';
import { decodeGif, parseGif } from '../assets/gifdecode.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}\n${e.stack}`);
    process.exitCode = 1;
  }
}

// a clip whose pixel (x, y) of frame i is [x, y, i, 255]
function clip(w, h, n, delays = Array(n).fill(10)) {
  const frames = [];
  for (let i = 0; i < n; i++) {
    const f = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f.set([x, y, i, 255], (y * w + x) * 4);
    frames.push(f);
  }
  return { w, h, frames, delays, loop: 0 };
}
const px = (f, w, x, y) => [...f.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
const sum = (a) => a.reduce((x, y) => x + y, 0);

test('cut keeps or removes an inclusive range', () => {
  const c = clip(2, 2, 6, [1, 2, 3, 4, 5, 6].map((d) => d * 10));
  let p = plan(c, [{ type: 'cut', from: 1, to: 3, mode: 'keep' }]);
  assert.deepEqual(p.idx, [1, 2, 3]);
  assert.deepEqual(p.delays, [20, 30, 40]);
  p = plan(c, [{ type: 'cut', from: 1, to: 3, mode: 'remove' }]);
  assert.deepEqual(p.idx, [0, 4, 5]);
  assert.throws(() => plan(c, [{ type: 'cut', from: 0, to: 5, mode: 'remove' }]));
  assert.throws(() => plan(c, [{ type: 'cut', from: 3, to: 1 }]));
});

test('slowing down keeps every frame and scales the time', () => {
  const c = clip(1, 1, 5, [10, 7, 3, 10, 10]);
  const p = plan(c, [{ type: 'speed', factor: 0.5 }]);
  assert.deepEqual(p.idx, [0, 1, 2, 3, 4]);
  assert.equal(sum(p.delays), 80);
});

test('speeding up past 2 cs per frame drops frames but keeps the length', () => {
  const c = clip(1, 1, 40, Array(40).fill(4)); // 25 fps, 1.6 s
  const p = plan(c, [{ type: 'speed', factor: 4 }]); // would be 1 cs per frame
  assert.ok(p.delays.every((d) => d >= 2), `delays ${p.delays}`);
  assert.equal(sum(p.delays), 40);
  assert.ok(p.idx.length <= 20 && p.idx.length >= 19, `${p.idx.length} frames`);
  for (let k = 1; k < p.idx.length; k++) assert.ok(p.idx[k] > p.idx[k - 1]);
});

test('speed 1x changes nothing', () => {
  const c = clip(1, 1, 7, [2, 3, 10, 7, 12, 5, 2]);
  const p = plan(c, [{ type: 'speed', factor: 1 }]);
  assert.deepEqual(p.idx, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(p.delays, c.delays);
});

test('same delay, drop frames, reverse, boomerang', () => {
  const c = clip(1, 1, 5, [10, 20, 30, 40, 50]);
  assert.deepEqual(plan(c, [{ type: 'delay', cs: 7 }]).delays, [7, 7, 7, 7, 7]);
  const d = plan(c, [{ type: 'drop', every: 2 }]);
  assert.deepEqual(d.idx, [0, 2, 4]);
  assert.deepEqual(d.delays, [30, 70, 50]);
  const r = plan(c, [{ type: 'reverse' }]);
  assert.deepEqual(r.idx, [4, 3, 2, 1, 0]);
  assert.deepEqual(r.delays, [50, 40, 30, 20, 10]);
  const b = plan(c, [{ type: 'reverse', boomerang: true }]);
  assert.deepEqual(b.idx, [0, 1, 2, 3, 4, 3, 2, 1]);
  assert.deepEqual(b.delays, [10, 20, 30, 40, 50, 40, 30, 20]);
});

test('crop, rotate and flip move pixels exactly', () => {
  const c = clip(5, 3, 2);
  let p = plan(c, [{ type: 'crop', x: 1, y: 1, w: 3, h: 2 }]);
  assert.equal(p.w, 3);
  assert.equal(p.h, 2);
  let f = drawFrame(c, p, 1);
  assert.deepEqual(px(f, 3, 0, 0), [1, 1, 1, 255]);
  assert.deepEqual(px(f, 3, 2, 1), [3, 2, 1, 255]);

  p = plan(c, [{ type: 'rotate', deg: 90 }]); // clockwise: top-left goes to top-right
  assert.equal(p.w, 3);
  assert.equal(p.h, 5);
  f = drawFrame(c, p, 0);
  assert.deepEqual(px(f, 3, 2, 0), [0, 0, 0, 255]);
  assert.deepEqual(px(f, 3, 0, 0), [0, 2, 0, 255]);
  assert.deepEqual(px(f, 3, 0, 4), [4, 2, 0, 255]);

  p = plan(c, [{ type: 'rotate', deg: 270 }]);
  f = drawFrame(c, p, 0);
  assert.deepEqual(px(f, 3, 0, 4), [0, 0, 0, 255]); // top-left goes to bottom-left

  p = plan(c, [{ type: 'rotate', deg: 180 }]);
  f = drawFrame(c, p, 0);
  assert.deepEqual(px(f, 5, 0, 0), [4, 2, 0, 255]);

  p = plan(c, [{ type: 'flip', h: true, v: false }]);
  f = drawFrame(c, p, 0);
  assert.deepEqual(px(f, 5, 0, 0), [4, 0, 0, 255]);
  p = plan(c, [{ type: 'flip', h: false, v: true }]);
  f = drawFrame(c, p, 0);
  assert.deepEqual(px(f, 5, 0, 0), [0, 2, 0, 255]);

  // four quarter turns and two flips give back the original
  p = plan(c, [{ type: 'rotate', deg: 90 }, { type: 'rotate', deg: 90 }, { type: 'flip', h: true, v: true }]);
  assert.deepEqual(drawFrame(c, p, 1), c.frames[1]);
});

test('index-only plans reuse the source frames', () => {
  const c = clip(3, 3, 4);
  const p = plan(c, [{ type: 'reverse' }]);
  assert.equal(drawFrame(c, p, 0), c.frames[3]);
});

test('overlay blends over the chosen frames only, clipped to the frame', () => {
  const c = clip(4, 3, 3);
  c.frames[1][(1 * 4 + 3) * 4 + 3] = 0; // pixel (3, 1) of frame 1 is transparent
  // a 2 x 2 picture at (2, 1): opaque white, half-transparent red, nothing, half-transparent red
  const rgba = new Uint8ClampedArray([255, 255, 255, 255, 255, 0, 0, 128, 0, 0, 0, 0, 255, 0, 0, 128]);
  const p = plan(c, [{ type: 'overlay', x: 2, y: 1, w: 2, h: 2, rgba, first: 1, last: 1 }]);
  assert.equal(drawFrame(c, p, 0), c.frames[0], 'frames outside the range are not touched');
  const f = drawFrame(c, p, 1);
  assert.notEqual(f, c.frames[1], 'the source frame is not changed');
  assert.deepEqual(px(f, 4, 2, 1), [255, 255, 255, 255]);
  assert.deepEqual(px(f, 4, 3, 1), [255, 0, 0, 128], 'over a transparent pixel, the overlay is all that shows');
  assert.deepEqual(px(f, 4, 2, 2), [2, 2, 1, 255], 'a transparent overlay pixel changes nothing');
  const [r, g, b, a] = px(f, 4, 3, 2);
  assert.equal(a, 255);
  assert.ok(Math.abs(r - (255 * 128 + 3 * 127) / 255) <= 1 && Math.abs(g - (2 * 127) / 255) <= 1, `${[r, g, b]}`);
  assert.deepEqual(px(f, 4, 0, 0), [0, 0, 1, 255]);
  // partly outside the frame
  const q = plan(c, [{ type: 'overlay', x: -1, y: 2, w: 2, h: 2, rgba }]);
  assert.deepEqual(px(drawFrame(c, q, 2), 4, 0, 2), [255, 0, 0, 255].map((v, i) => (i < 3 ? Math.round((v * 128 + [0, 2, 2][i] * 127) / 255) : 255)));
  assert.throws(() => plan(c, [{ type: 'overlay', x: 0, y: 0, w: 3, h: 3, rgba }]));
});

test('resize: flat colour stays flat, sizes are right, transparency is kept', () => {
  const w = 37;
  const h = 23;
  const f = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) f.set([200, 100, 50, 255], i * 4);
  for (const [nw, nh] of [[10, 6], [74, 46], [37, 23], [1, 1], [100, 3]]) {
    const r = resize(f, w, h, nw, nh);
    assert.equal(r.length, nw * nh * 4);
    for (let i = 0; i < nw * nh; i++) assert.deepEqual([...r.subarray(i * 4, i * 4 + 4)], [200, 100, 50, 255], `${nw}x${nh} pixel ${i}`);
  }
  // left half transparent (with junk colour), right half red: the edge must not turn dark
  const g = new Uint8ClampedArray(20 * 10 * 4);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) g.set(x < 10 ? [0, 255, 0, 0] : [255, 0, 0, 255], (y * 20 + x) * 4);
  const r = resize(g, 20, 10, 7, 4);
  for (let i = 0; i < 7 * 4; i++) {
    const [R, G, , A] = r.subarray(i * 4, i * 4 + 4);
    if (A > 0) assert.ok(R > 240 && G < 10, `pixel ${i}: ${[...r.subarray(i * 4, i * 4 + 4)]}`);
  }
});

test('the GIF reader reads the test GIF', () => {
  const bytes = new Uint8Array(readFileSync(new URL('../../tests/data/tiny.gif', import.meta.url)));
  const info = parseGif(bytes);
  assert.equal(info.width, 24);
  assert.equal(info.frames.length, 6);
  assert.equal(info.loopCount, 0);
  const g = decodeGif(bytes);
  assert.equal(g.frames.length, 6);
  assert.deepEqual(g.delays, [8, 8, 8, 8, 8, 8]);
  // bottom bar is blue in every frame, top-left corner transparent
  for (const f of g.frames) {
    assert.deepEqual(px(f, 24, 5, 20), [30, 90, 200, 255]);
    assert.equal(f[3], 0);
  }
});

// a GIF with a two-colour palette whose frames each hold one pixel of index 0
function makeGif(w, h, frames) {
  const b = [...'GIF89a'].map((c) => c.charCodeAt(0));
  const u16 = (v) => b.push(v & 255, v >> 8);
  u16(w); u16(h); b.push(0x80, 0, 0, 0, 0, 0, 255, 255, 255);
  for (const f of frames) {
    b.push(0x21, 0xf9, 4, ((f.disposal ?? 0) << 2) | (f.trans ? 1 : 0), 10, 0, 0, 0);
    b.push(0x2c); u16(f.x ?? 0); u16(f.y ?? 0); u16(f.w); u16(f.h);
    b.push(0, 2, 2, 0x44, 0x01, 0);
  }
  b.push(0x3b);
  return new Uint8Array(b);
}

test('the GIF reader sizes its buffers by the data, not by what a frame claims', () => {
  // 70 bytes whose second frame claims 65535x65535 pixels: this used to allocate 4 GB, and the
  // oversized buffer then broke every later decode
  const before = process.memoryUsage().arrayBuffers;
  const g = decodeGif(makeGif(1, 1, [{ w: 1, h: 1 }, { w: 65535, h: 65535 }]));
  assert.deepEqual(g.complete, [true, false]);
  assert.deepEqual(px(g.frames[0], 1, 0, 0), [0, 0, 0, 255]);
  assert.ok(process.memoryUsage().arrayBuffers - before < 64e6);
  assert.equal(decodeGif(readFileSync(new URL('../../tests/data/tiny.gif', import.meta.url))).frames.length, 6);
});

test('the GIF reader works out which frames build on which in near-linear time', () => {
  // transparent frames that keep the last, each followed by an opaque "restore previous" frame
  // inside all of them: walking back frame by frame (as Skia does) took 8 s for these
  const frames = [];
  for (let i = 0; i < 40000; i++) frames.push(i % 2 ? { w: 1, h: 1, disposal: 3 } : { w: 1, h: 1, trans: true });
  const t = performance.now();
  const info = parseGif(makeGif(2, 1, frames));
  assert.ok(performance.now() - t < 2000, `took ${Math.round(performance.now() - t)} ms`);
  assert.equal(info.frames[39998].requiredFrame, 39996);
  assert.equal(info.frames[39999].requiredFrame, -1);
});

test('the GIF reader picks the same required frames as Skia', () => {
  // SkFrameHolder::setAlphaAndRequiredFrame, one frame at a time
  const skia = (frames, W, H) => {
    const clip = (f) => {
      const r = [Math.min(f.left, W), Math.min(f.top, H), Math.min(f.left + f.width, W), Math.min(f.top + f.height, H)];
      return r[0] < r[2] && r[1] < r[3] ? r : null;
    };
    const full = (r) => r && r[0] === 0 && r[1] === 0 && r[2] === W && r[3] === H;
    const contains = (a, b) => a && b && a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];
    const req = [];
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i], alpha = f.transparentIndex >= 0, rect = clip(f);
      req[i] = -1;
      if (i === 0 || (!alpha && full(rect))) continue;
      let p = i - 1;
      while (p >= 0 && frames[p].dispose === 3) p--;
      if (p < 0 || (frames[p].dispose === 2 && (full(clip(frames[p])) || req[p] === -1))) continue;
      if (alpha) { req[i] = p; continue; }
      while (p >= 0 && contains(rect, clip(frames[p]))) p = req[p];
      req[i] = p;
    }
    return req;
  };
  let seed = 7;
  const rnd = (n) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) % n;
  for (let c = 0; c < 3000; c++) {
    const W = 1 + rnd(4), H = 1 + rnd(4);
    const shapes = [[0, 0, W, H], [0, 0, 1, 1], null];
    const usual = rnd(3); // repeating one shape builds long chains
    const frames = Array.from({ length: 1 + rnd(30) }, () => {
      const s = shapes[rnd(2) ? usual : rnd(3)] || [rnd(W + 1), rnd(H + 1), rnd(W + 1), rnd(H + 1)];
      return { x: s[0], y: s[1], w: s[2], h: s[3], disposal: rnd(5), trans: rnd(2) === 1 };
    });
    const info = parseGif(makeGif(W, H, frames));
    assert.deepEqual(info.frames.map((f) => f.requiredFrame), skia(info.frames, info.width, info.height), `case ${c}`);
  }
});

console.log(`${passed} tests passed${process.exitCode ? ', some failed' : ''}`);
