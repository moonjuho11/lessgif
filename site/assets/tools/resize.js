import { gifTool } from '../app.js';

const MAX = 4096;
const ui = gifTool({
  current: 'resize',
  verb: 'Resize',
  suffix: '-resized',
  quality: 90,
  setup(ui) {
    const { w, h } = ui.clip;
    ui.$('[name=w]').value = w;
    ui.$('[name=h]').value = h;
  },
  ops(ui) {
    const w = Math.round(+ui.$('[name=w]').value);
    const h = Math.round(+ui.$('[name=h]').value);
    if (!(w >= 1 && h >= 1)) throw new Error('Enter a width and a height of at least 1 pixel.');
    if (w > MAX || h > MAX) throw new Error(`The browser version handles up to ${MAX} x ${MAX} pixels.`);
    return [{ type: 'resize', w, h }];
  },
});

const W = ui.$('[name=w]');
const H = ui.$('[name=h]');
const locked = () => ui.$('[name=lock]').checked;
W.oninput = () => {
  if (locked() && ui.clip && +W.value > 0) H.value = Math.max(1, Math.round((+W.value * ui.clip.h) / ui.clip.w));
};
H.oninput = () => {
  if (locked() && ui.clip && +H.value > 0) W.value = Math.max(1, Math.round((+H.value * ui.clip.w) / ui.clip.h));
};
for (const b of ui.form.querySelectorAll('[data-k]')) {
  b.onclick = () => {
    const k = +b.dataset.k;
    W.value = Math.max(1, Math.round(ui.clip.w * k));
    H.value = Math.max(1, Math.round(ui.clip.h * k));
  };
}
