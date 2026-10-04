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

console.log(`${passed} tests passed${process.exitCode ? ', some failed' : ''}`);
