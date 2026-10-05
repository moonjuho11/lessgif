import { $, el, engine, fmt, dropZone, outputControls, progressBox, errorBox, resultBox, handedOver } from '../app.js';
import { sniff, loadClip, checkBudget } from '../load.js';
import { fit } from '../ops.js';

const host = $('#tool');
const err = errorBox();
const prog = progressBox();
const result = resultBox({ current: 'maker' });
const output = outputControls({ quality: 80, sizeTarget: true, target: 8 });

// each item: { name, bmp: ImageBitmap, ms }
let items = [];
const list = el('div', { class: 'thumbs' });
const add = el('button', { type: 'button', class: 'btn small secondary' }, 'Add more images');
const sortBtn = el('button', { type: 'button', class: 'btn small secondary' }, 'Sort by file name');
const clear = el('button', { type: 'button', class: 'btn small secondary' }, 'Remove all');
const count = el('span', { class: 'hint' });
const framesCard = el('section', { class: 'card', hidden: true }, el('h2', {}, 'Frames'), list, el('div', { class: 'actions', style: 'margin-top:12px' }, add, sortBtn, clear, count));

const form = el('form', { class: 'card opts', hidden: true, novalidate: true });
form.innerHTML = `
  <h2>Settings</h2>
  <div class="field"><span>Delay for every frame (milliseconds)</span>
    <div class="row" style="gap:8px"><input type="number" name="all" min="20" step="10" value="200" aria-label="Delay for every frame"><button type="button" class="btn small secondary" data-setall>Set all</button></div>
    <small>New pictures get this delay. Each frame's own delay is in the box under it.</small>
  </div>
  <div class="field"><span>Size (longest side, pixels)</span>
    <div class="seg" role="radiogroup" aria-label="Size">
      ${[240, 320, 480, 640, 800].map((s) => `<label><input type="radio" name="side" value="${s}" ${s === 480 ? 'checked' : ''}>${s}</label>`).join('')}
      <label><input type="radio" name="side" value="0">First image's size</label>
    </div>
  </div>
  <div class="field"><span>Pictures of a different shape</span>
    <div class="seg" role="radiogroup" aria-label="Fit">
      <label><input type="radio" name="fit" value="contain" checked>Fit inside</label>
      <label><input type="radio" name="fit" value="cover">Fill and crop</label>
    </div>
  </div>
  <p class="hint" data-summary></p>
  <h3>Output</h3>`;
const go = el('button', { class: 'btn big', type: 'submit' }, 'Make GIF');
form.append(output.el, el('div', { class: 'actions' }, go));

const drop = dropZone({ accept: 'image/*', multiple: true, title: 'Drop images here', hint: 'PNG, JPEG, WebP or GIF. Your pictures stay on this device.' }, addFiles);
host.append(drop, err.el, framesCard, form, prog.el, result.el);
add.onclick = () => drop.querySelector('input').click();

const val = (n) => form.querySelector(`[name=${n}]`);

function size() {
  if (!items.length) return [0, 0];
  const first = items[0].bmp;
  const side = +form.querySelector('[name=side]:checked').value || Math.max(first.width, first.height);
  return fit(first.width, first.height, side);
}

function render() {
  list.replaceChildren(
    ...items.map((it, i) => {
      const c = el('canvas', { width: 160, height: 120 });
      const k = Math.min(160 / it.bmp.width, 120 / it.bmp.height);
      c.getContext('2d').drawImage(it.bmp, (160 - it.bmp.width * k) / 2, (120 - it.bmp.height * k) / 2, it.bmp.width * k, it.bmp.height * k);
      const ms = el('input', { type: 'number', min: 20, step: 10, value: it.ms, 'aria-label': `Delay of frame ${i + 1} in ms`, title: 'Delay in ms' });
      ms.onchange = () => (it.ms = Math.max(20, +ms.value || 20));
      const move = (d) => () => {
        const j = i + d;
        if (j < 0 || j >= items.length) return;
        [items[i], items[j]] = [items[j], items[i]];
        render();
      };
      return el(
        'div',
        { class: 'thumb' },
        c,
        ms,
        el(
          'div',
          { class: 'tb' },
          el('button', { type: 'button', title: 'Move earlier', 'aria-label': 'Move earlier', onclick: move(-1) }, '←'),
          el('span', { title: it.name }, `${i + 1}. ${it.name}`),
          el('button', { type: 'button', title: 'Move later', 'aria-label': 'Move later', onclick: move(1) }, '→'),
          el('button', { type: 'button', title: 'Remove', 'aria-label': 'Remove', onclick: () => (items.splice(i, 1), render()) }, '×'),
        ),
      );
    }),
  );
  const has = items.length > 0;
  framesCard.hidden = form.hidden = !has;
  drop.hidden = has;
  count.textContent = `${items.length} frame${items.length === 1 ? '' : 's'}, ${fmt.secs(items.reduce((a, it) => a + Math.round(it.ms / 10), 0))}`;
  summary();
}

function summary() {
  const out = form.querySelector('[data-summary]');
  if (!items.length) return;
  const [w, h] = size();
  out.textContent = `${items.length} frames of ${w} x ${h}.`;
  try {
    checkBudget(w, h, items.length);
  } catch (e) {
    out.textContent = e.message;
  }
}
form.addEventListener('change', summary);

async function addFiles(files) {
  err.hide();
  result.hide();
  prog.onCancel = () => engine.cancel();
  try {
    for (const [n, f] of files.entries()) {
      prog.show(`Reading ${f.name || 'image'} (${n + 1} of ${files.length})`, n, files.length);
      const kind = await sniff(f);
      if (kind === 'video') throw new Error(`${f.name} is a video. Use Video to GIF for videos.`);
      const clip = await loadClip(f, kind, engine);
      for (const [i, fr] of clip.frames.entries()) {
        const bmp = await createImageBitmap(new ImageData(fr, clip.w, clip.h));
        const name = clip.frames.length > 1 ? `${f.name} #${i + 1}` : f.name || 'image';
        items.push({ name, bmp, ms: clip.frames.length > 1 ? clip.delays[i] * 10 : +val('all').value || 200 });
      }
    }
  } catch (e) {
    if (!e.cancelled) err.show(e.message);
  } finally {
    prog.hide();
    render();
  }
}

sortBtn.onclick = () => {
  items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  render();
};
clear.onclick = () => {
  items = [];
  render();
};
form.querySelector('[data-setall]').onclick = () => {
  const ms = Math.max(20, +val('all').value || 200);
  for (const it of items) it.ms = ms;
  render();
};

form.onsubmit = async (e) => {
  e.preventDefault();
  err.hide();
  result.hide();
  let out;
  try {
    out = output.read();
    if (!items.length) throw new Error('Add some images first.');
  } catch (x) {
    err.show(x.message);
    return;
  }
  const [w, h] = size();
  try {
    checkBudget(w, h, items.length);
  } catch (x) {
    err.show(x.message);
    return;
  }
  go.disabled = true;
  prog.onCancel = () => engine.cancel();
  try {
    const cover = form.querySelector('[name=fit]:checked').value === 'cover';
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    const frames = [];
    for (const [i, it] of items.entries()) {
      prog.show(`Preparing frame ${i + 1} of ${items.length}`, i + 1, items.length);
      const k = (cover ? Math.max : Math.min)(w / it.bmp.width, h / it.bmp.height);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(it.bmp, (w - it.bmp.width * k) / 2, (h - it.bmp.height * k) / 2, it.bmp.width * k, it.bmp.height * k);
      frames.push(ctx.getImageData(0, 0, w, h).data.buffer);
      if (i % 20 === 19) await new Promise((r) => setTimeout(r));
    }
    const delays = items.map((it) => Math.max(2, Math.round(it.ms / 10)));
    const r = await engine.run('encode', { clip: { w, h, frames, delays, loop: 0 }, ops: [], out }, frames, (p) => prog.show(p.text, p.done, p.total));
    result.show(r, { name: 'animation.gif' });
  } catch (x) {
    if (!x.cancelled) err.show(x.message);
  } finally {
    go.disabled = false;
    prog.hide();
  }
};

handedOver().then((f) => f && addFiles(f));
