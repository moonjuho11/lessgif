// Probe: raw VideoFrame bytes (copyTo) of ImageDecoder output, to check pixel content without canvas.
import { launch } from './lib/chromium.mjs';
const [file, ...frames] = process.argv.slice(2);
const h = await launch();
const res = await h.page.evaluate(async ({ url, frames }) => {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const dec = new ImageDecoder({ data: bytes, type: 'image/gif' });
  await dec.tracks.ready;
  const out = [];
  for (const step of frames) {
    const partial = step.endsWith('p'); const i = parseInt(step);
    try {
      const r = await dec.decode({ frameIndex: i, completeFramesOnly: !partial });
      const im = r.image;
      const buf = new Uint8Array(im.allocationSize());
      await im.copyTo(buf);
      const W = im.codedWidth;
      let s = `${step}: format=${im.format} ${W}x${im.codedHeight}\n`;
      for (let y = 0; y < im.codedHeight; y++) { for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; s += buf[o + 3] === 0 ? '.' : buf[o + 3] === 255 ? 'O' : '?'; } s += '\n'; }
      out.push(s); im.close();
    } catch (e) { out.push(`${step}: ERR ${e.message}`); }
  }
  return out.join('\n');
}, { url: h.urlFor(file), frames });
console.log(res);
await h.close();
