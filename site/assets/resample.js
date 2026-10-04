// Resizes RGBA frames. Separable Catmull-Rom (bicubic), widened when shrinking so every source
// pixel contributes, computed in premultiplied alpha so transparent pixels don't darken the edges
// of what's visible. The same input gives the same output in every browser, unlike canvas scaling.

function cubic(x) {
  x = Math.abs(x);
  if (x < 1) return (1.5 * x - 2.5) * x * x + 1;
  if (x < 2) return ((-0.5 * x + 2.5) * x - 4) * x + 2;
  return 0;
}

// For each output position: the first source index and the normalised weights of its taps.
function taps(src, dst) {
  const scale = src / dst;
  const fs = Math.max(scale, 1);
  const sup = 2 * fs;
  const n = Math.ceil(sup) * 2 + 2;
  const start = new Int32Array(dst);
  const count = new Int32Array(dst);
  const w = new Float32Array(dst * n);
  for (let i = 0; i < dst; i++) {
    const c = (i + 0.5) * scale;
    const lo = Math.max(0, Math.floor(c - sup));
    const hi = Math.min(src, Math.ceil(c + sup));
    let sum = 0;
    for (let j = lo; j < hi; j++) {
      const v = cubic((j + 0.5 - c) / fs);
      w[i * n + j - lo] = v;
      sum += v;
    }
    if (sum) for (let j = 0; j < hi - lo; j++) w[i * n + j] /= sum;
    start[i] = lo;
    count[i] = hi - lo;
  }
  return { start, count, w, n };
}

const cache = new Map();
function tapsCached(src, dst) {
  const k = `${src}>${dst}`;
  let t = cache.get(k);
  if (!t) {
    if (cache.size > 16) cache.clear();
    t = taps(src, dst);
    cache.set(k, t);
  }
  return t;
}

export function resize(rgba, w, h, nw, nh) {
  if (nw === w && nh === h) return new Uint8ClampedArray(rgba);
  // premultiply
  const pre = new Float32Array(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    pre[i] = rgba[i] * a;
    pre[i + 1] = rgba[i + 1] * a;
    pre[i + 2] = rgba[i + 2] * a;
    pre[i + 3] = rgba[i + 3];
  }
  // horizontal pass: w x h -> nw x h
  const tx = tapsCached(w, nw);
  const mid = new Float32Array(nw * h * 4);
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    const orow = y * nw * 4;
    for (let x = 0; x < nw; x++) {
      const s = tx.start[x];
      const c = tx.count[x];
      const wo = x * tx.n;
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < c; j++) {
        const k = tx.w[wo + j];
        const p = row + (s + j) * 4;
        r += pre[p] * k;
        g += pre[p + 1] * k;
        b += pre[p + 2] * k;
        a += pre[p + 3] * k;
      }
      const o = orow + x * 4;
      mid[o] = r;
      mid[o + 1] = g;
      mid[o + 2] = b;
      mid[o + 3] = a;
    }
  }
  // vertical pass: nw x h -> nw x nh, then un-premultiply
  const ty = tapsCached(h, nh);
  const out = new Uint8ClampedArray(nw * nh * 4);
  const stride = nw * 4;
  for (let y = 0; y < nh; y++) {
    const s = ty.start[y];
    const c = ty.count[y];
    const wo = y * ty.n;
    const orow = y * stride;
    for (let x = 0; x < stride; x += 4) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < c; j++) {
        const k = ty.w[wo + j];
        const p = (s + j) * stride + x;
        r += mid[p] * k;
        g += mid[p + 1] * k;
        b += mid[p + 2] * k;
        a += mid[p + 3] * k;
      }
      const o = orow + x;
      if (a >= 0.5) {
        const m = 255 / a;
        out[o] = r * m; // Uint8ClampedArray rounds and clamps
        out[o + 1] = g * m;
        out[o + 2] = b * m;
        out[o + 3] = a;
      }
    }
  }
  return out;
}
