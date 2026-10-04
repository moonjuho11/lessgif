// Playwright harness: decode GIFs with Chromium's WebCodecs ImageDecoder and with
// site/assets/gifdecode.js in the same page and compare every frame's RGBA and every delay.
//
// usage: node compare.mjs [--sample N] [--seed S] [--name LABEL] [--out results/LABEL.jsonl] <files or dirs...>
// Prints one line per file and a summary; writes JSON lines with full details to --out.
import { launch } from './lib/chromium.mjs';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
let sample = 0, seed = 1, name = 'run', outFile = null, quiet = false;
const inputs = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--sample') sample = +args[++i];
  else if (a === '--seed') seed = +args[++i];
  else if (a === '--name') name = args[++i];
  else if (a === '--out') outFile = args[++i];
  else if (a === '--quiet') quiet = true;
  else inputs.push(a);
}
let files = [];
for (const p of inputs) {
  if (fs.statSync(p).isDirectory()) files.push(...fs.readdirSync(p).filter(f => f.toLowerCase().endsWith('.gif')).sort().map(f => path.join(p, f)));
  else files.push(p);
}
if (sample && files.length > sample) {
  // Deterministic sample (mulberry32).
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const idx = files.map((f, i) => [rnd(), i]).sort((a, b) => a[0] - b[0]).slice(0, sample).map(x => x[1]).sort((a, b) => a - b);
  files = idx.map(i => files[i]);
}
outFile = outFile || path.join(path.dirname(new URL(import.meta.url).pathname), 'results', `${name}.jsonl`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const out = fs.createWriteStream(outFile);

const h = await launch();
await h.page.evaluate(`import('/site/test/decoder/lib/harness-page.js').then(m => { window.H = m; })`);
await h.page.waitForFunction(() => !!window.H);
const counts = {};
const failures = [];
const t0 = Date.now();
for (const f of files) {
  let res;
  try {
    res = await h.page.evaluate(async (url) => window.H.compareOne(url), h.urlFor(f));
  } catch (e) {
    res = { url: f, status: 'fail', reason: 'harness error: ' + e.message.slice(0, 300) };
    // Recover the page if it crashed.
    try { await h.page.goto(h.page.url()); await h.page.evaluate(`import('/site/test/decoder/lib/harness-page.js').then(m => { window.H = m; })`); await h.page.waitForFunction(() => !!window.H); } catch {}
  }
  res.file = f;
  counts[res.status] = (counts[res.status] || 0) + 1;
  if (res.status === 'fail') failures.push(res);
  out.write(JSON.stringify(res) + '\n');
  if (!quiet || res.status === 'fail') {
    const extra = res.status === 'fail' ? ' :: ' + res.reason : (res.notes && res.notes.length ? ' :: ' + res.notes[0] : '');
    console.log(`${res.status.padEnd(24)} ${path.basename(f)} chrome=${res.chrome?.frames}f ours=${res.ours?.frames ?? 'ERR'}f${extra}`);
  }
}
await h.close();
out.end();
const total = files.length;
console.log(`\n[${name}] ${total} files in ${((Date.now() - t0) / 1000).toFixed(1)}s: ` + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '));
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  ' + f.file + ' :: ' + f.reason);
}
