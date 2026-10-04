// Checks that the WebAssembly build produces byte-for-byte the same GIFs as the native build.
// node web/test/identity.mjs <lessgif.wasm> <encode_raw binary>
// (CI builds both: see .github/workflows/ci.yml.)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LessGif, delaysForFps } from '../lessgif.js';

const [wasmPath, nativeBin] = process.argv.slice(2);
const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {});
const gz = new LessGif(instance.exports);

// deterministic test clips (no files needed)
function lcg(seed) {
  let s = BigInt(seed);
  return () => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number(s >> 33n);
  };
}
function clip(w, h, n, px) {
  const frames = [];
  for (let i = 0; i < n; i++) {
    const f = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f.set(px(i, x, y), (y * w + x) * 4);
    frames.push(f);
  }
  return { w, h, n, frames };
}
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const clips = {
  gradient: (() => {
    const r = lcg(1);
    return clip(96, 64, 12, (i, x, y) => {
      const nz = (r() % 9) - 4;
      return [clamp((x * 255) / 96 + i * 3 + nz), clamp((y * 255) / 64 + nz), clamp(128 + 100 * Math.sin((x + y) * 0.1 + i * 0.15)), 255];
    });
  })(),
  sprite: clip(64, 48, 10, (i, x, y) => {
    const d = Math.hypot(x - 15 - i * 3, y - 24);
    if (i === 5) return [0, 0, 0, 0];
    if (d < 12) return [clamp(200 - d * 4), 60 + i * 10, 90, 255];
    if (d < 13.5) return [255, 255, 0, i % 2 ? 160 : 100];
    return [0, 0, 0, 0];
  }),
  cartoon: clip(80, 60, 8, (i, x, y) => {
    if (x >= i * 4 && x < i * 4 + 20 && y >= 20 && y < 35) return [[200, 40, 40], [40, 160, 70], [50, 90, 220]][i % 3].concat(255);
    return ((x >> 3) + (y >> 3)) % 2 ? [255, 255, 255, 255] : [250, 240, 200, 255];
  }),
  noise: (() => {
    const r = lcg(7);
    return clip(40, 30, 5, () => [r() & 255, r() & 255, r() & 255, 255]);
  })(),
  odd: clip(7, 3, 4, (i, x, y) => [x * 30 + i, y * 80, 128, 255]),
};
const settings = [{ quality: 0 }, { quality: 30 }, { quality: 70 }, { quality: 90 }, { quality: 100 }, { lambda: 60, tbias: 150 }];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lessgif-identity-'));
let same = 0, total = 0;
for (const [name, c] of Object.entries(clips)) {
  const raw = Buffer.alloc(16 + c.n * c.w * c.h * 4);
  raw.write('RGBA', 0);
  raw.writeUInt32LE(c.w, 4);
  raw.writeUInt32LE(c.h, 8);
  raw.writeUInt32LE(c.n, 12);
  c.frames.forEach((f, i) => raw.set(f, 16 + i * f.length));
  fs.writeFileSync(path.join(dir, 'clip.rgba'), raw);
  for (const s of settings) {
    const args = s.quality === undefined ? ['--lambda', `${s.lambda}`, '--tbias', `${s.tbias}`] : ['--quality', `${s.quality}`];
    execFileSync(nativeBin, [path.join(dir, 'clip.rgba'), path.join(dir, 'native.gif'), ...args]);
    const native = fs.readFileSync(path.join(dir, 'native.gif'));
    const { gif } = gz.encode({ w: c.w, h: c.h, n: c.n, getFrame: (i) => c.frames[i], delays: delaysForFps(c.n, 15), ...s });
    total++;
    if (Buffer.compare(native, Buffer.from(gif)) === 0) same++;
    else console.log(`DIFFERENT: ${name} ${JSON.stringify(s)}: native ${native.length} bytes, wasm ${gif.length} bytes`);
  }
}
fs.rmSync(dir, { recursive: true });
console.log(`${same} of ${total} encodes identical`);
process.exit(same === total ? 0 : 1);
