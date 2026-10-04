import { gifTool, fmt, frameThumbs } from '../app.js';

let start = null; // first click of a two-click selection

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
    frameThumbs(ui.$('[data-frames]'), ui.clip, pick);
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
