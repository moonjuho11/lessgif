import { gifTool } from '../app.js';

let sel = { x: 0, y: 0, w: 1, h: 1 }; // in image pixels
const ui = gifTool({
  current: 'crop',
  verb: 'Crop',
  suffix: '-cropped',
  quality: 100,
  bigPreview: false,
  setup(ui) {
    const { w, h, frames } = ui.clip;
    canvas.width = w;
    canvas.height = h;
    // small GIFs are shown enlarged (up to 4x) so the box is easy to handle
    canvas.style.width = `${Math.round(w * Math.min(4, Math.max(1, 520 / Math.max(w, h))))}px`;
    canvas.getContext('2d').putImageData(new ImageData(frames[0], w, h), 0, 0);
    // start with a box inset from the edges so it's obvious it can be dragged
    const m = Math.round(Math.min(w, h) * 0.1);
    sel = { x: m, y: m, w: Math.max(1, w - 2 * m), h: Math.max(1, h - 2 * m) };
    applyRatio();
    draw();
  },
  ops: () => [{ type: 'crop', ...sel }],
});

const box = ui.$('[data-cropper]');
const canvas = box.querySelector('canvas');
const selEl = box.querySelector('.sel');
const field = (n) => ui.$(`[name=${n}]`);
const ratio = () => +ui.$('[name=ratio]:checked').value;

function clamp() {
  const { w: W, h: H } = ui.clip;
  sel.w = Math.max(1, Math.min(W, Math.round(sel.w)));
  sel.h = Math.max(1, Math.min(H, Math.round(sel.h)));
  sel.x = Math.max(0, Math.min(W - sel.w, Math.round(sel.x)));
  sel.y = Math.max(0, Math.min(H - sel.h, Math.round(sel.y)));
}

function draw() {
  clamp();
  const k = canvas.clientWidth / ui.clip.w || 1;
  Object.assign(selEl.style, { left: `${sel.x * k}px`, top: `${sel.y * k}px`, width: `${sel.w * k}px`, height: `${sel.h * k}px` });
  for (const n of ['x', 'y', 'w', 'h']) field(n).value = sel[n];
}

// Largest box of the chosen shape, centred on the current one.
function applyRatio() {
  const r = ratio();
  if (!r) return;
  const { w: W, h: H } = ui.clip;
  const cx = sel.x + sel.w / 2;
  const cy = sel.y + sel.h / 2;
  let w = Math.min(sel.w, W);
  let h = w / r;
  if (h > Math.min(sel.h, H)) {
    h = Math.min(sel.h, H);
    w = h * r;
  }
  sel = { x: cx - w / 2, y: cy - h / 2, w, h };
}

let drag = null;
box.addEventListener('pointerdown', (e) => {
  if (!ui.clip) return;
  e.preventDefault();
  const k = canvas.clientWidth / ui.clip.w;
  const r = canvas.getBoundingClientRect();
  const px = (e.clientX - r.left) / k;
  const py = (e.clientY - r.top) / k;
  const handle = e.target.dataset?.h;
  if (handle) drag = { mode: handle, px, py, s: { ...sel } };
  else if (e.target === selEl) drag = { mode: 'move', px, py, s: { ...sel } };
  else drag = { mode: 'new', px, py, s: { x: px, y: py, w: 1, h: 1 } };
  box.setPointerCapture(e.pointerId);
});
box.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const k = canvas.clientWidth / ui.clip.w;
  const r = canvas.getBoundingClientRect();
  const px = Math.max(0, Math.min(ui.clip.w, (e.clientX - r.left) / k));
  const py = Math.max(0, Math.min(ui.clip.h, (e.clientY - r.top) / k));
  const s = drag.s;
  if (drag.mode === 'move') {
    sel = { ...s, x: s.x + px - drag.px, y: s.y + py - drag.py };
  } else {
    // the corner opposite the one being dragged stays put
    const fixed = drag.mode === 'new' ? { x: s.x, y: s.y } : { x: drag.mode.includes('w') ? s.x + s.w : s.x, y: drag.mode.includes('n') ? s.y + s.h : s.y };
    let w = Math.abs(px - fixed.x);
    let h = Math.abs(py - fixed.y);
    const rr = ratio();
    if (rr) {
      if (w / h > rr) w = h * rr;
      else h = w / rr;
    }
    sel = { x: px < fixed.x ? fixed.x - w : fixed.x, y: py < fixed.y ? fixed.y - h : fixed.y, w: Math.max(1, w), h: Math.max(1, h) };
  }
  draw();
});
const end = () => (drag = null);
box.addEventListener('pointerup', end);
box.addEventListener('pointercancel', end);

for (const n of ['x', 'y', 'w', 'h']) {
  field(n).onchange = () => {
    sel[n] = +field(n).value || 0;
    if (ratio() && (n === 'w' || n === 'h')) {
      if (n === 'w') sel.h = sel.w / ratio();
      else sel.w = sel.h * ratio();
    }
    draw();
  };
}
for (const r of ui.form.querySelectorAll('[name=ratio]')) {
  r.onchange = () => {
    if (!ui.clip) return;
    applyRatio();
    draw();
  };
}
new ResizeObserver(() => ui.clip && draw()).observe(canvas);
