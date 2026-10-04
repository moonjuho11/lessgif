// Show what Chromium's ImageDecoder returns for small GIFs (used to discover edge-case behaviour).
// usage: node probe.mjs [--ours] a.gif b.gif ...
// Prints frame count, repetitionCount, per-frame duration/complete and an ASCII picture of each frame
// ('.' = alpha 0, letters = distinct colours, legend below). With --ours, prints our decoder's output too.
import { launch, PAGE_HELPERS } from './lib/chromium.mjs';
import fs from 'node:fs';

const args = process.argv.slice(2);
const ours = args.includes('--ours');
const files = args.filter(a => !a.startsWith('--'));
const h = await launch();
await h.page.evaluate(PAGE_HELPERS);
if (ours) await h.page.evaluate(`import('/site/assets/gifdecode.js').then(m => { window.GD = m; })`);

function show(label, res) {
  const lines = [];
  lines.push(`${label}: count=${res.frameCount} rep=${res.repetitionCount} size=${res.width}x${res.height}` + (res.error ? ` ERROR@${res.errorAt}: ${res.error}` : '') + (res.frameCountAfter !== undefined && res.frameCountAfter !== res.frameCount ? ` countAfter=${res.frameCountAfter}` : '') + (res.warnings && res.warnings.length ? ` warnings=${JSON.stringify(res.warnings)}` : ''));
  const legend = new Map();
  res.frames.forEach((f, i) => {
    lines.push(`  frame ${i}: dur=${f.duration} complete=${f.complete}${f.raw !== undefined ? ' raw=' + f.raw : ''}${f.partial ? ' PARTIAL' : ''}${f.error ? ' error=' + JSON.stringify(f.error) : ''}`);
    if (!f.rgba || f.w * f.h > 64 * 40) return;
    for (let y = 0; y < f.h; y++) {
      let s = '    ';
      for (let x = 0; x < f.w; x++) {
        const o = (y * f.w + x) * 4;
        const a = f.rgba[o + 3];
        if (a === 0) { s += '.'; continue; }
        const key = `${f.rgba[o]},${f.rgba[o + 1]},${f.rgba[o + 2]},${a}`;
        if (!legend.has(key)) legend.set(key, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#@$%&*+=?'[legend.size] || '!');
        s += legend.get(key);
      }
      lines.push(s);
    }
  });
  if (legend.size) lines.push('  legend: ' + [...legend].map(([k, v]) => `${v}=${k}`).join(' '));
  return lines.join('\n');
}

for (const f of files) {
  const url = h.urlFor(f);
  const res = await h.page.evaluate(async (url) => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const r = await window.chromeDecodeAll(bytes);
    r.frames.forEach(fr => { if (fr.rgba) fr.rgba = Array.from(fr.rgba); });
    return r;
  }, url);
  console.log(show('chrome ' + f.split('/').pop(), res));
  if (ours) {
    const o = await h.page.evaluate(async (url) => {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      try {
        const d = window.GD.decodeGif(bytes);
        return { frameCount: d.frames.length, repetitionCount: d.loopCount, width: d.width, height: d.height, warnings: d.warnings,
          frames: d.frames.map((fr, i) => ({ rgba: Array.from(fr), w: d.width, h: d.height, duration: d.delays[i] * 10000, raw: d.rawDelays[i] })) };
      } catch (e) { return { error: e.message, errorAt: 'open', frames: [] }; }
    }, url);
    console.log(show('ours   ' + f.split('/').pop(), o));
  }
}
await h.close();
