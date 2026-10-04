// Probe: does the partial-frame output depend on decode order / options?
import { launch } from './lib/chromium.mjs';
const [file, ...orders] = process.argv.slice(2);
const h = await launch();
await h.page.evaluate((v) => { window.CLOSE = true; window.READREP = v[0]; window.REUSE = v[1]; }, [!!process.env.READREP, !!process.env.REUSE]);
for (const order of orders) {
  const res = await h.page.evaluate(async ({ url, order }) => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const dec = new ImageDecoder({ data: bytes, type: 'image/gif' });
    await dec.tracks.ready;
    const out = [];
    if (window.READREP) out.push('rep=' + dec.tracks.selectedTrack.repetitionCount + ' count=' + dec.tracks.selectedTrack.frameCount);
    for (const step of order.split(',')) {
      const partial = step.endsWith('p');
      const i = parseInt(step);
      try {
        const r = await dec.decode({ frameIndex: i, completeFramesOnly: !partial });
        let c, ctx;
        if (window.REUSE) { if (!window._c) { window._c = new OffscreenCanvas(r.image.displayWidth, r.image.displayHeight); window._x = window._c.getContext('2d', { willReadFrequently: true }); } c = window._c; ctx = window._x; ctx.clearRect(0, 0, c.width, c.height); }
        else { c = new OffscreenCanvas(r.image.displayWidth, r.image.displayHeight); ctx = c.getContext('2d'); }
        ctx.drawImage(r.image, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let s = '';
        for (let y = 0; y < c.height; y++) { for (let x = 0; x < c.width; x++) { const o = (y * c.width + x) * 4; s += d[o + 3] ? '0123456789abcdef'[(d[o] >> 6) * 4 + (d[o + 1] >> 6)] : '.'; } s += '\n'; }
        if (window.CLOSE) r.image.close();
        out.push(`${step}: ok complete=${r.complete}\n${s}`);
      } catch (e) { out.push(`${step}: ERR ${e.message}`); }
    }
    dec.close();
    return out.join('\n');
  }, { url: h.urlFor(file), order });
  console.log(`== order ${order}\n${res}`);
}
await h.close();
