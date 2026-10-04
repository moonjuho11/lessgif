import { gifTool, fmt, el } from '../app.js';

const MAX_THUMBS = 400;
let start = null; // first click of a two-click selection
let drawing = 0;

const ui = gifTool({
  current: 'cut',
  verb: 'Cut',
  suffix: '-cut',
  quality: 100,
  setup(ui) {
    const n = ui.clip.frames.length;
    ui.$('[name=from]').max = ui.$('[name=to]').max = n;
    ui.$('[name=from]').value = 1;
    ui.$('[name=to]').value = n;
    start = null;
    thumbs(ui.clip);
    update();
  },
  ops(ui) {
    const [from, to] = range();
    return [{ type: 'cut', from: from - 1, to: to - 1, mode: ui.$('[name=mode]:checked').value }];
  },
});

function range() {
  const n = ui.clip.frames.length;
  const a = Math.round(+ui.$('[name=from]').value);
  const b = Math.round(+ui.$('[name=to]').value);
  if (!(a >= 1 && b >= 1 && a <= n && b <= n)) throw new Error(`Frame numbers go from 1 to ${n}.`);
  if (a > b) throw new Error('The first frame has to come before the last one.');
  return [a, b];
}

async function thumbs(clip) {
  const box = ui.$('[data-frames]');
  box.replaceChildren();
  const job = ++drawing;
  const n = clip.frames.length;
  const step = Math.ceil(n / MAX_THUMBS);
  const tw = Math.min(120, clip.w);
  const th = Math.max(1, Math.round((tw * clip.h) / clip.w));
  let t = 0;
  let full;
  for (let i = 0; i < n; i++) {
    const at = t;
    t += clip.delays[i];
    if (i % step) continue;
    const c = el('canvas', { width: tw, height: th });
    const b = el('button', { type: 'button', 'data-i': i + 1, title: `Frame ${i + 1} at ${fmt.secs(at)}` }, c, `${i + 1}`);
    b.onclick = () => pick(i + 1);
    box.append(b);
  }
  update();
  for (const b of box.children) {
    if (job !== drawing) return;
    const f = clip.frames[+b.dataset.i - 1];
    if (!f.byteLength) return; // frames are busy in the encoder; the boxes stay blank
    const g = b.firstChild.getContext('2d');
    try {
      const bmp = await createImageBitmap(new ImageData(f, clip.w, clip.h), { resizeWidth: tw, resizeHeight: th, resizeQuality: 'medium' });
      g.drawImage(bmp, 0, 0);
      bmp.close();
    } catch {
      // browsers without createImageBitmap resizing: draw full size, then scale
      full ??= Object.assign(document.createElement('canvas'), { width: clip.w, height: clip.h });
      full.getContext('2d').putImageData(new ImageData(f, clip.w, clip.h), 0, 0);
      g.drawImage(full, 0, 0, tw, th);
    }
  }
}

function pick(i) {
  if (start === null) {
    start = i;
    ui.$('[name=from]').value = i;
    ui.$('[name=to]').value = i;
  } else {
    ui.$('[name=from]').value = Math.min(start, i);
    ui.$('[name=to]').value = Math.max(start, i);
    start = null;
  }
  update();
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
  const keep = ui.$('[name=mode]:checked').value === 'keep';
  for (const btn of ui.$('[data-frames]').children) {
    const i = +btn.dataset.i;
    const sel = i >= a && i <= b;
    btn.className = sel ? 'in' : keep ? 'out' : '';
  }
  const d = ui.clip.delays;
  const t0 = d.slice(0, a - 1).reduce((x, y) => x + y, 0);
  const sel = d.slice(a - 1, b).reduce((x, y) => x + y, 0);
  const all = d.reduce((x, y) => x + y, 0);
  const n = ui.clip.frames.length;
  const cnt = b - a + 1;
  out.textContent = keep
    ? `Keeps frames ${a} to ${b} (${fmt.secs(t0)} to ${fmt.secs(t0 + sel)}): ${cnt} frame${cnt > 1 ? 's' : ''}, ${fmt.secs(sel)}.`
    : `Removes frames ${a} to ${b}, leaving ${n - cnt} frame${n - cnt === 1 ? '' : 's'} and ${fmt.secs(all - sel)}.`;
}

ui.$('[name=from]').oninput = ui.$('[name=to]').oninput = update;
for (const r of ui.form.querySelectorAll('[name=mode]')) r.onchange = update;
