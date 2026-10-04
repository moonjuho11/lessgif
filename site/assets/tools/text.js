import { gifTool, el, root } from '../app.js';

// The meme font comes with the site so it looks the same everywhere; the others are the device's.
const FONTS = {
  meme: { family: 'Anton, Impact, "Arial Narrow", sans-serif', weight: 400, line: 1.15 },
  sans: { family: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif', weight: 700, line: 1.2 },
  serif: { family: 'Georgia, "Times New Roman", serif', weight: 700, line: 1.2 },
  mono: { family: 'ui-monospace, Menlo, Consolas, "Courier New", monospace', weight: 700, line: 1.2 },
};
const ANTON = [
  ['anton-latin', 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'],
  ['anton-latin-ext', 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF'],
];
for (const [file, unicodeRange] of ANTON) document.fonts.add(new FontFace('Anton', `url(${root}assets/fonts/${file}.woff2)`, { unicodeRange }));
document.fonts.load('400 20px Anton', 'A').catch(() => {});

const MARGIN = 0.04; // gap between the text and the top or bottom edge, as a share of the height

let layers = []; // { text, font, size, color, stroke, outline, caps, pos, cx, cy, first, last, r }
let cur = 0;
let at = 1; // the frame in the preview, from 1

const ui = gifTool({
  current: 'add-text',
  verb: 'Add text',
  suffix: '-text',
  quality: 90,
  bigPreview: false,
  setup(ui) {
    const { w, h, frames } = ui.clip;
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${Math.round(w * Math.min(4, Math.max(1, 520 / Math.max(w, h))))}px`;
    const n = frames.length;
    const at_ = ui.$('[name=at]');
    at_.max = n;
    at_.value = at = 1;
    ui.$('[data-at-row]').hidden = n < 2;
    for (const f of ['first', 'last']) ui.$(`[name=${f}]`).max = n;
    layers = [newLayer(null)];
    cur = 0;
    load();
    ui.$('[name=text]').focus();
  },
  ops() {
    const n = ui.clip.frames.length;
    const shown = layers.filter((L) => L.r);
    if (!shown.length) throw new Error('Write some text first.');
    return shown.map((L) => {
      if (!(L.first >= 1 && L.last <= n && L.first <= L.last)) throw new Error(`Text ${layers.indexOf(L) + 1}: frames go from 1 to ${n}, and the first can't come after the last.`);
      const p = place(L);
      return { type: 'overlay', x: p.x, y: p.y, w: L.r.w, h: L.r.h, rgba: L.r.rgba, first: L.first - 1, last: L.last - 1 };
    });
  },
});

const box = ui.$('[data-texter]');
const canvas = box.querySelector('canvas');
const g = canvas.getContext('2d');
const selEl = box.querySelector('.tsel');
const field = (n) => ui.$(`[name=${n}]`);

function newLayer(like = layers[cur]) {
  const { w, h, frames } = ui.clip;
  return {
    text: '',
    font: like?.font ?? 'meme',
    size: like?.size ?? Math.max(12, Math.round(Math.min(h / 7, w / 8))),
    color: like?.color ?? '#ffffff',
    stroke: like?.stroke ?? '#000000',
    outline: like?.outline ?? 0.09,
    caps: like?.caps ?? true,
    pos: like ? (layers.some((L) => L.pos === 'bottom') ? 'middle' : 'bottom') : 'top',
    cx: 0.5,
    cy: 0.5,
    first: 1,
    last: frames.length,
    r: null,
  };
}

// The layer's text drawn on a canvas cropped to the visible pixels: { c, w, h, rgba, wide }.
function render(L) {
  const text = (L.caps ? L.text.toUpperCase() : L.text).replace(/\s+$/, '');
  if (!text.trim()) return null;
  const f = FONTS[L.font];
  const size = Math.max(1, Math.round(L.size));
  const font = `${f.weight} ${size}px ${f.family}`;
  const sw = L.outline ? Math.max(1, Math.round(size * L.outline)) : 0;
  const W = ui.clip.w;
  const m = document.createElement('canvas').getContext('2d');
  m.font = font;
  // wrap at the width of the GIF, leaving a small margin
  const maxW = Math.max(size, W * 0.94 - 2 * sw);
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/ +/)) {
      const t = line ? `${line} ${word}` : word;
      if (line && m.measureText(t).width > maxW) {
        lines.push(line);
        line = word;
      } else line = t;
    }
    lines.push(line);
  }
  const lh = Math.round(size * f.line);
  const pad = sw + Math.ceil(size * 0.5); // room for accents and descenders; cropped off below
  const cw = Math.ceil(Math.max(...lines.map((l) => m.measureText(l).width))) + 2 * pad;
  const ch = lh * lines.length + 2 * pad;
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const x = c.getContext('2d', { willReadFrequently: true });
  Object.assign(x, { font, textAlign: 'center', textBaseline: 'middle', lineJoin: 'round', lineWidth: 2 * sw, strokeStyle: L.stroke, fillStyle: L.color });
  lines.forEach((l, i) => {
    const y = pad + lh * (i + 0.5);
    if (sw) x.strokeText(l, cw / 2, y);
    x.fillText(l, cw / 2, y);
  });
  // crop to what was drawn, so "top" and "bottom" put the letters themselves at the margin
  const all = x.getImageData(0, 0, cw, ch).data;
  let x0 = cw, y0 = ch, x1 = -1, y1 = -1;
  for (let yy = 0; yy < ch; yy++) {
    for (let xx = 0; xx < cw; xx++) {
      if (!all[(yy * cw + xx) * 4 + 3]) continue;
      if (xx < x0) x0 = xx;
      if (xx > x1) x1 = xx;
      if (yy < y0) y0 = yy;
      if (yy > y1) y1 = yy;
    }
  }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const rgba = x.getImageData(x0, y0, w, h).data;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
  return { c: out, w, h, rgba, wide: w > W };
}

// Where the layer goes, in GIF pixels (its top-left corner).
function place(L) {
  const { w: W, h: H } = ui.clip;
  const { w, h } = L.r;
  const m = Math.round(H * MARGIN);
  if (L.pos === 'custom') return { x: Math.round(L.cx * W - w / 2), y: Math.round(L.cy * H - h / 2) };
  return { x: Math.round((W - w) / 2), y: L.pos === 'top' ? m : L.pos === 'bottom' ? H - m - h : Math.round((H - h) / 2) };
}

const shows = (L) => at >= L.first && at <= L.last;

function paint() {
  if (!ui.clip) return;
  const { w, h, frames } = ui.clip;
  const f = frames[at - 1];
  if (f.byteLength) g.putImageData(new ImageData(f, w, h), 0, 0); // empty while the encoder has the frames
  for (const L of layers) {
    if (L.r && shows(L)) {
      const p = place(L);
      g.drawImage(L.r.c, p.x, p.y);
    }
  }
  const L = layers[cur];
  selEl.hidden = !L.r;
  if (L.r) {
    const k = canvas.clientWidth / w || 1;
    const p = place(L);
    Object.assign(selEl.style, { left: `${p.x * k - 3}px`, top: `${p.y * k - 3}px`, width: `${L.r.w * k + 6}px`, height: `${L.r.h * k + 6}px` });
    selEl.classList.toggle('off', !shows(L));
  }
}

// Re-draws the text of a layer, again once its font has loaded.
function refresh(L) {
  L.r = render(L);
  const f = FONTS[L.font];
  const font = `${f.weight} ${Math.round(L.size)}px ${f.family}`;
  if (L.r && !document.fonts.check(font, L.text)) {
    document.fonts.load(font, L.text).then(() => {
      L.r = render(L);
      paint();
      summary();
    }, () => {});
  }
}

function bar() {
  const short = (t) => (t.length > 14 ? `${t.slice(0, 13)}…` : t);
  ui.$('[data-layers]').replaceChildren(
    ...layers.map((L, i) => el('button', { type: 'button', class: 'btn small secondary', 'aria-pressed': String(i === cur), onclick: () => select(i) }, `Text ${i + 1}${L.text.trim() ? `: ${short(L.text.trim())}` : ''}`)),
    el('button', { type: 'button', class: 'btn small secondary', onclick: add }, '+ Add another text'),
    ...(layers.length > 1 ? [el('button', { type: 'button', class: 'btn small secondary', onclick: remove }, 'Remove this text')] : []),
  );
}

function summary() {
  const n = ui.clip.frames.length;
  const L = layers[cur];
  const out = [];
  if (L.r?.wide) out.push('This text is wider than the GIF: make it smaller, or add line breaks.');
  if (n > 1 && L.text.trim()) out.push(L.first === 1 && L.last === n ? `Text ${cur + 1} shows on every frame.` : `Text ${cur + 1} shows on frames ${L.first} to ${L.last} of ${n}.`);
  ui.$('[data-summary]').textContent = out.join(' ');
  ui.$('[name=at]').nextElementSibling.textContent = `${at} of ${n}`;
}

// fields -> layer
function read() {
  const L = layers[cur];
  L.text = field('text').value;
  L.font = field('font').value;
  L.size = Math.max(1, Math.min(1000, +field('size').value || L.size));
  L.color = field('color').value;
  L.stroke = field('stroke').value;
  L.outline = +ui.$('[name=outline]:checked').value;
  L.caps = field('caps').checked;
  L.first = Math.round(+field('first').value);
  L.last = Math.round(+field('last').value);
  refresh(L);
  bar();
  paint();
  summary();
}

// layer -> fields
function load() {
  const L = layers[cur];
  field('text').value = L.text;
  field('font').value = L.font;
  field('size').value = L.size;
  field('color').value = L.color;
  field('stroke').value = L.stroke;
  for (const r of ui.form.querySelectorAll('[name=outline]')) r.checked = +r.value === L.outline;
  field('caps').checked = L.caps;
  for (const r of ui.form.querySelectorAll('[name=pos]')) r.checked = r.value === L.pos;
  field('first').value = L.first;
  field('last').value = L.last;
  refresh(L);
  bar();
  paint();
  summary();
}

function select(i) {
  cur = i;
  load();
}
function add() {
  layers.push(newLayer());
  select(layers.length - 1);
  field('text').focus();
}
function remove() {
  layers.splice(cur, 1);
  select(Math.max(0, cur - 1));
}

for (const n of ['text', 'size', 'first', 'last']) field(n).addEventListener('input', read);
for (const n of ['font', 'color', 'stroke', 'caps']) field(n).addEventListener('input', read);
for (const r of ui.form.querySelectorAll('[name=outline]')) r.addEventListener('change', read);
for (const r of ui.form.querySelectorAll('[name=pos]')) {
  r.addEventListener('change', () => {
    Object.assign(layers[cur], { pos: r.value, cx: 0.5 });
    paint();
  });
}
ui.$('[data-allframes]').onclick = () => {
  field('first').value = 1;
  field('last').value = ui.clip.frames.length;
  read();
};
field('at').addEventListener('input', () => {
  at = Math.round(+field('at').value);
  paint();
  summary();
});

// drag a text to move it; a click elsewhere moves the selected text there
let drag = null;
function toGif(e) {
  const r = canvas.getBoundingClientRect();
  const k = r.width / ui.clip.w;
  return [(e.clientX - r.left) / k, (e.clientY - r.top) / k];
}
function moveTo(L, x, y) {
  const { w: W, h: H } = ui.clip;
  L.pos = 'custom';
  L.cx = Math.max(0, Math.min(W, x)) / W;
  L.cy = Math.max(0, Math.min(H, y)) / H;
  for (const r of ui.form.querySelectorAll('[name=pos]')) r.checked = false;
  paint();
}
box.addEventListener('pointerdown', (e) => {
  if (!ui.clip) return;
  e.preventDefault();
  const [px, py] = toGif(e);
  let hit = -1;
  for (let i = layers.length - 1; i >= 0; i--) {
    const L = layers[i];
    if (!L.r || !shows(L)) continue;
    const p = place(L);
    if (px >= p.x && px < p.x + L.r.w && py >= p.y && py < p.y + L.r.h) {
      hit = i;
      break;
    }
  }
  if (hit >= 0 && hit !== cur) select(hit);
  const L = layers[cur];
  if (!L.r) return;
  if (hit < 0) {
    moveTo(L, px, py);
    drag = { dx: 0, dy: 0 };
  } else {
    const p = place(L);
    drag = { dx: px - (p.x + L.r.w / 2), dy: py - (p.y + L.r.h / 2) };
  }
  box.setPointerCapture(e.pointerId);
});
box.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const [px, py] = toGif(e);
  moveTo(layers[cur], px - drag.dx, py - drag.dy);
});
const end = () => (drag = null);
box.addEventListener('pointerup', end);
box.addEventListener('pointercancel', end);
new ResizeObserver(() => ui.clip && paint()).observe(canvas);
