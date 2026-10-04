import { gifTool, fmt } from '../app.js';
import { plan } from '../ops.js';

const factorOf = (v) => Math.round(2 ** +v * 100) / 100; // slider is log2 of the speed
const ui = gifTool({
  current: 'speed',
  verb: 'Change speed',
  suffix: '-speed',
  quality: 100,
  setup: () => summary(),
  ops,
});

function ops(ui) {
  if (ui.$('[name=mode]:checked').value === 'delay') {
    const ms = +ui.$('[name=ms]').value;
    if (!(ms >= 20)) throw new Error('The delay has to be at least 20 ms.');
    return [{ type: 'delay', cs: Math.round(ms / 10) }];
  }
  return [{ type: 'speed', factor: factorOf(ui.$('[name=factor]').value) }];
}

function summary() {
  const out = ui.$('[data-summary]');
  ui.$('.range output').textContent = `${factorOf(ui.$('[name=factor]').value)}x`;
  if (!ui.clip) return;
  try {
    const p = plan(ui.clip, ops(ui));
    const was = ui.clip.delays.reduce((a, b) => a + b, 0);
    const now = p.delays.reduce((a, b) => a + b, 0);
    const n = ui.clip.frames.length;
    out.textContent = `Length ${fmt.secs(was)} becomes ${fmt.secs(now)}` + (p.idx.length < n ? `; ${n - p.idx.length} of ${n} frames are skipped to reach that speed.` : '.');
  } catch (e) {
    out.textContent = e.message;
  }
}

for (const r of ui.form.querySelectorAll('[name=mode]')) {
  r.onchange = () => {
    const m = ui.$('[name=mode]:checked').value;
    for (const f of ui.form.querySelectorAll('[data-mode]')) f.hidden = f.dataset.mode !== m;
    summary();
  };
}
ui.$('[name=factor]').oninput = summary;
ui.$('[name=ms]').oninput = summary;
for (const b of ui.form.querySelectorAll('[data-f]')) {
  b.onclick = () => {
    ui.$('[name=factor]').value = Math.log2(+b.dataset.f);
    summary();
  };
}
summary();
