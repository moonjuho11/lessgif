import { $, el, engine, fmt, fact, dropZone, outputControls, progressBox, errorBox, resultBox, handedOver } from '../app.js';
import { openVideo, videoFrames, checkBudget } from '../load.js';
import { fit } from '../ops.js';

const MAX_SECONDS = 120;
const host = $('#tool');
const err = errorBox();
const prog = progressBox();
const result = resultBox({ current: 'video-to-gif' });
const output = outputControls({ quality: 70, sizeTarget: true, target: 8 });

const player = el('video', { controls: true, muted: true, playsinline: true });
const facts = el('ul', { class: 'facts' });
const another = el('button', { type: 'button', class: 'btn small secondary' }, 'Use another video');
const srcCard = el('section', { class: 'card', hidden: true }, el('h2', {}, 'Input'), el('div', { class: 'preview' }, el('figure', { class: 'shot' }, el('div', { class: 'frame' }, player))), facts, el('div', { class: 'actions', style: 'margin-top:12px' }, another));

const form = el('form', { class: 'card opts', hidden: true, novalidate: true });
form.innerHTML = `
  <h2>Settings</h2>
  <div class="row">
    <div class="field"><span>Start (seconds)</span><div class="row" style="gap:6px"><input type="number" name="start" min="0" step="0.1" value="0"><button type="button" class="btn small secondary" data-now="start">Use current</button></div></div>
    <div class="field"><span>End (seconds)</span><div class="row" style="gap:6px"><input type="number" name="end" min="0" step="0.1" value="5"><button type="button" class="btn small secondary" data-now="end">Use current</button></div></div>
  </div>
  <div class="field"><span>Frames per second</span>
    <div class="seg" role="radiogroup" aria-label="Frames per second">
      ${[5, 10, 15, 20, 25, 30].map((f) => `<label><input type="radio" name="fps" value="${f}" ${f === 15 ? 'checked' : ''}>${f}</label>`).join('')}
    </div>
  </div>
  <div class="field"><span>Size (longest side, pixels)</span>
    <div class="seg" role="radiogroup" aria-label="Size">
      ${[240, 320, 480, 640, 800].map((s) => `<label><input type="radio" name="side" value="${s}" ${s === 480 ? 'checked' : ''}>${s}</label>`).join('')}
      <label><input type="radio" name="side" value="0">Original</label>
    </div>
  </div>
  <p class="hint" data-summary></p>
  <h3>Output</h3>`;
const go = el('button', { class: 'btn big', type: 'submit' }, 'Make GIF');
form.append(output.el, el('div', { class: 'actions' }, go));

const drop = dropZone({ accept: 'video/*,.mp4,.webm,.mov,.m4v,.mkv', title: 'Drop a video here', hint: 'MP4, WebM or MOV. Your video stays on this device.' }, ([f]) => setSource(f));
host.append(drop, err.el, srcCard, form, prog.el, result.el);

let video = null;
let file = null;
const f = (n) => form.querySelector(`[name=${n}]`);

function settings() {
  const start = Math.max(0, +f('start').value || 0);
  const end = Math.min(video.duration, +f('end').value || 0);
  if (!(end > start)) throw new Error('The end has to be after the start.');
  if (end - start > MAX_SECONDS) throw new Error(`The browser version makes GIFs up to ${MAX_SECONDS} seconds long.`);
  const fps = +form.querySelector('[name=fps]:checked').value;
  const side = +form.querySelector('[name=side]:checked').value || Math.max(video.videoWidth, video.videoHeight);
  const [w, h] = fit(video.videoWidth, video.videoHeight, side);
  return { start, end, fps, w, h };
}

function summary() {
  const out = form.querySelector('[data-summary]');
  try {
    const s = settings();
    const n = Math.max(1, Math.round((s.end - s.start) * s.fps));
    out.textContent = `${(s.end - s.start).toFixed(1)} s at ${s.fps} frames per second: ${n} frames of ${s.w} x ${s.h}.`;
    checkBudget(s.w, s.h, n);
  } catch (e) {
    out.textContent = e.message;
  }
}
form.addEventListener('input', summary);
form.addEventListener('change', summary);
for (const b of form.querySelectorAll('[data-now]')) {
  b.onclick = () => {
    f(b.dataset.now).value = player.currentTime.toFixed(1);
    summary();
  };
}
another.onclick = () => drop.querySelector('input').click();

async function setSource(fl) {
  err.hide();
  result.hide();
  try {
    if (video) URL.revokeObjectURL(video.src);
    video = await openVideo(fl);
    file = fl;
    player.src = video.src;
    const d = video.duration;
    f('start').max = f('end').max = d.toFixed(2);
    f('start').value = 0;
    f('end').value = Math.min(d, 5).toFixed(1);
    facts.replaceChildren(
      ...[
        ['File', fl.name || 'video'],
        ['Size', fmt.bytes(fl.size)],
        ['Dimensions', `${video.videoWidth} x ${video.videoHeight}`],
        ['Length', `${d.toFixed(1)} s`],
      ].map(([k, v]) => fact(k, v)),
    );
    const small = Math.max(video.videoWidth, video.videoHeight) < 480;
    if (small) form.querySelector('[name=side][value="0"]').checked = true;
    drop.hidden = true;
    srcCard.hidden = false;
    form.hidden = false;
    summary();
  } catch (e) {
    err.show(e.message);
  }
}

form.onsubmit = async (e) => {
  e.preventDefault();
  err.hide();
  result.hide();
  let s, out;
  try {
    s = settings();
    out = output.read();
  } catch (x) {
    err.show(x.message);
    return;
  }
  go.disabled = true;
  const abort = new AbortController();
  prog.onCancel = () => {
    abort.abort();
    engine.cancel();
  };
  prog.show('Reading video frames');
  player.pause();
  try {
    const clip = await videoFrames(video, { ...s, signal: abort.signal, onProgress: (p) => prog.show(p.text, p.done, p.total) });
    const buffers = clip.frames.map((x) => x.buffer);
    const r = await engine.run('encode', { clip: { ...clip, frames: buffers }, ops: [], out }, buffers, (p) => prog.show(p.text, p.done, p.total));
    result.show(r, { name: `${(file.name || 'video').replace(/\.[^.]+$/, '')}.gif` });
  } catch (x) {
    if (!x.cancelled) err.show(x.message);
  } finally {
    go.disabled = false;
    prog.hide();
  }
};

handedOver().then((fl) => fl && setSource(fl[0]));
