import { gifTool, el, fmt, fact, frameThumbs, stem } from '../app.js';
import { zip } from '../zip.js';

const resultCard = el('section', { class: 'card', hidden: true, id: 'result' });
let url;

const ui = gifTool({
  current: 'split',
  verb: 'Download as ZIP',
  output: false,
  bigPreview: false,
  setup(ui) {
    const n = ui.clip.frames.length;
    ui.$('[name=from]').max = ui.$('[name=to]').max = n;
    ui.$('[name=from]').value = 1;
    ui.$('[name=to]').value = n;
    frameThumbs(ui.$('[data-frames]'), ui.clip, (i) => saveOne(i).catch((e) => alert(e.message)));
    resultCard.hidden = true;
    update();
  },
  async run(ui, { progress, signal }) {
    resultCard.hidden = true;
    const [a, b] = range();
    const type = format();
    const base = stem(ui.file.name);
    const files = [];
    const t0 = performance.now();
    for (let i = a; i <= b; i++) {
      if (signal.aborted) throw new Error('Cancelled.');
      const blob = await picture(i, type);
      files.push({ name: name(base, i, type), bytes: new Uint8Array(await blob.arrayBuffer()) });
      progress(`Saving frame ${i - a + 1} of ${b - a + 1}`, i - a + 1, b - a + 1);
    }
    show(zip(files), files, `${base}-frames.zip`, performance.now() - t0);
  },
});
ui.host.append(resultCard);

const format = () => ui.$('[name=format]:checked').value;

function range() {
  const n = ui.clip.frames.length;
  const a = Math.round(+ui.$('[name=from]').value);
  const b = Math.round(+ui.$('[name=to]').value);
  if (!(a >= 1 && b >= 1 && a <= n && b <= n)) throw new Error(`Frame numbers go from 1 to ${n}.`);
  if (a > b) throw new Error('The first frame has to come before the last one.');
  return [a, b];
}

// frame-001.png ... with as many digits as the last frame number needs (at least 3)
function name(base, i, type) {
  const digits = Math.max(3, String(ui.clip.frames.length).length);
  return `${base}-${String(i).padStart(digits, '0')}.${type}`;
}

// Frame i (from 1) as a PNG or JPG; JPG has no transparency, so it goes on white.
async function picture(i, type) {
  const { w, h, frames } = ui.clip;
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = c.getContext('2d');
  const img = new ImageData(frames[i - 1], w, h);
  if (type === 'png') g.putImageData(img, 0, 0);
  else {
    const tmp = await createImageBitmap(img);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.drawImage(tmp, 0, 0);
    tmp.close();
  }
  const mime = type === 'png' ? 'image/png' : 'image/jpeg';
  if (c.convertToBlob) return c.convertToBlob({ type: mime, quality: 0.92 });
  return new Promise((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error("This browser couldn't save the picture."))), mime, 0.92));
}

async function saveOne(i) {
  const type = format();
  const blob = await picture(i, type);
  const href = URL.createObjectURL(blob);
  const a = el('a', { href, download: name(stem(ui.file.name), i, type) });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60000);
}

function show(blob, files, fileName, ms) {
  if (url) URL.revokeObjectURL(url);
  url = URL.createObjectURL(blob);
  const n = files.length;
  const facts = [
    ['Pictures', String(n)],
    ['ZIP size', fmt.bytes(blob.size)],
    ['Names', n > 1 ? `${files[0].name} to ${files[n - 1].name}` : files[0].name],
    ['Took', `${(ms / 1000).toFixed(1)} s`],
  ];
  resultCard.replaceChildren(
    el('h2', {}, 'Result'),
    el('ul', { class: 'facts' }, ...facts.map(([k, v]) => fact(k, v))),
    el('div', { class: 'actions', style: 'margin-top:12px' }, el('a', { class: 'btn', href: url, download: fileName }, 'Download ZIP')),
  );
  resultCard.hidden = false;
  resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function update() {
  if (!ui.clip) return;
  const out = ui.$('[data-summary]');
  let a, b;
  try {
    [a, b] = range();
  } catch (e) {
    out.textContent = e.message;
    return;
  }
  for (const btn of ui.$('[data-frames]').children) {
    const i = +btn.dataset.i;
    btn.className = i >= a && i <= b ? '' : 'out';
  }
  const n = b - a + 1;
  out.textContent = `The ZIP will hold ${n} ${format().toUpperCase()} picture${n > 1 ? 's' : ''}, ${ui.clip.w} x ${ui.clip.h} each.`;
}

ui.$('[name=from]').oninput = ui.$('[name=to]').oninput = update;
for (const r of ui.form.querySelectorAll('[name=format]')) r.onchange = update;
