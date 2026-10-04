// Shared pieces of the tool pages: file picking, previews, output settings, progress, results,
// and passing a result on to another tool. gifTool() wires them into a complete page for the
// tools that edit an existing GIF; the video and images pages use the pieces directly.
import { Engine } from './engine.js';
import { sniff, loadClip } from './load.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const engine = new Engine();
// './' on the home page, '../' on a tool page
export const root = $('.logo')?.getAttribute('href') || './';

export const TOOLS = [
  ['compress', 'Compress'],
  ['resize', 'Resize'],
  ['crop', 'Crop'],
  ['cut', 'Cut'],
  ['speed', 'Speed'],
  ['reverse', 'Reverse'],
  ['rotate', 'Rotate'],
  ['add-text', 'Add text'],
  ['split', 'Split into frames'],
  ['gif-to-mp4', 'Convert to MP4'],
];

export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids.flat().filter((k) => k != null && k !== false));
  return e;
}

export const fmt = {
  bytes: (n) => (n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`),
  secs: (cs) => `${(cs / 100).toFixed(cs < 1000 ? 2 : 1)} s`,
  loop: (l) => (l === 0 ? 'loops forever' : l == null ? 'plays once' : `repeats ${l} time${l === 1 ? '' : 's'}`),
};

export const stem = (name) => (name || 'animation').replace(/\.[^.]+$/, '').replace(/-(small|resized|cropped|cut|speed|reversed|rotated|text)$/, '') || 'animation';

// ---------------------------------------------------------------- passing files between tools
const DB = 'lessgif';
function db() {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('handoff');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
// files: [{ blob, name }]
export async function stash(files) {
  const d = await db();
  await new Promise((ok, fail) => {
    const tx = d.transaction('handoff', 'readwrite');
    tx.objectStore('handoff').put(files, 'last');
    tx.oncomplete = ok;
    tx.onerror = () => fail(tx.error);
  });
}
export async function unstash() {
  const d = await db();
  const v = await new Promise((ok, fail) => {
    const r = d.transaction('handoff').objectStore('handoff').get('last');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
  return v?.length ? v.map((f) => new File([f.blob], f.name, { type: f.blob.type })) : null;
}
export async function openIn(tool, files) {
  try {
    await stash(files);
    location.href = `${root}${tool}/?from=last`;
  } catch {
    alert("This browser blocked passing the file to the next tool (private browsing can do this). Download it and open it there instead.");
  }
}
export async function handedOver() {
  if (new URLSearchParams(location.search).get('from') !== 'last') return null;
  history.replaceState(null, '', location.pathname);
  try {
    return await unstash();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- file picking
export function dropZone({ accept, multiple = false, title, hint }, onFiles) {
  const input = el('input', { type: 'file', accept, multiple });
  const zone = el(
    'label',
    { class: 'drop', tabindex: '0' },
    el('b', {}, title),
    el('small', {}, 'or'),
    el('span', { class: 'btn' }, multiple ? 'Choose files' : 'Choose a file'),
    el('small', {}, hint),
    input,
  );
  input.onchange = () => {
    if (input.files.length) onFiles([...input.files]);
    input.value = '';
  };
  zone.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  };
  // drop anywhere on the page, or paste
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('over');
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) zone.classList.remove('over');
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  });
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  });
  return zone;
}

// ---------------------------------------------------------------- output settings
function qualityHint(q, exact) {
  if (q >= 100) return exact ? 'Lossless: every pixel stays exactly as it is (when each frame fits in 255 colours).' : 'Best quality, biggest file.';
  if (q >= 90) return 'Near-lossless: very hard to tell apart from the original.';
  if (q >= 70) return 'High: looks like the original at normal size.';
  if (q >= 50) return 'Good: much smaller, with some grain if you look closely.';
  if (q >= 30) return 'Medium: visible grain and banding, small file.';
  return 'Low: the smallest files, clearly lower quality.';
}

let uid = 0;
export function outputControls({ quality = 70, sizeTarget = false, exact = false, keepLoop = false, target = 2 }) {
  const id = `o${++uid}`;
  const box = el('fieldset', { class: 'opts' });
  box.innerHTML = `
    <div class="field">
      <span>Quality</span>
      <div class="range"><input type="range" name="quality" min="1" max="100" value="${quality}" aria-label="Quality"><output>${quality}</output></div>
      <small data-hint></small>
    </div>
    ${
      sizeTarget
        ? `<div class="field">
      <label class="inline"><input type="checkbox" name="useTarget"> <span><b>Fit a size limit instead</b></span></label>
      <div class="row" data-target hidden>
        <input type="number" name="target" value="${target}" min="0.01" step="any" aria-label="Size limit">
        <select name="unit" aria-label="Unit"><option value="1024">KB</option><option value="1048576" selected>MB</option></select>
        <small>Picks the best quality that fits, and shrinks the GIF only if it has to.</small>
      </div>
    </div>`
        : ''
    }
    <details class="more">
      <summary>More output settings</summary>
      <div class="opts">
        <label class="field"><span>Colours</span><input type="number" name="colors" value="255" min="2" max="255"><small>Up to 255. Fewer colours make smaller files with more banding.</small></label>
        <div class="field"><span>Dithering</span><div class="range"><input type="range" name="dither" min="0" max="100" value="75" aria-label="Dithering"><output>75%</output></div><small>How much colour error is spread to neighbouring pixels. Less dithering looks flatter and compresses better.</small></div>
        <div class="field"><span>Looping</span>
          <div class="row">
            <select name="loop" aria-label="Looping">
              ${keepLoop ? '<option value="keep" selected>Keep as it is</option>' : ''}
              <option value="0" ${keepLoop ? '' : 'selected'}>Loop forever</option>
              <option value="once">Play once</option>
              <option value="n">Repeat a number of times</option>
            </select>
            <input type="number" name="repeats" value="3" min="1" max="65535" aria-label="Repeats" hidden>
          </div>
        </div>
      </div>
    </details>`;
  const q = box.querySelector('[name=quality]');
  const hint = box.querySelector('[data-hint]');
  const show = () => {
    box.querySelector('.range output').textContent = q.value;
    hint.textContent = qualityHint(+q.value, exact);
  };
  q.oninput = show;
  show();
  const d = box.querySelector('[name=dither]');
  d.oninput = () => (d.nextElementSibling.textContent = `${d.value}%`);
  const loopSel = box.querySelector('[name=loop]');
  loopSel.onchange = () => (box.querySelector('[name=repeats]').hidden = loopSel.value !== 'n');
  const use = box.querySelector('[name=useTarget]');
  if (use) {
    use.onchange = () => {
      box.querySelector('[data-target]').hidden = !use.checked;
      q.disabled = use.checked;
    };
  }
  return {
    el: box,
    read() {
      const out = {
        colors: Math.min(255, Math.max(2, Math.round(+box.querySelector('[name=colors]').value || 255))),
        dither: Math.min(100, Math.max(0, +d.value)) / 100,
      };
      if (use?.checked) {
        const bytes = Math.round(+box.querySelector('[name=target]').value * +box.querySelector('[name=unit]').value);
        if (!(bytes >= 1024)) throw new Error('The size limit has to be at least 1 KB.');
        out.targetBytes = bytes;
      } else {
        out.quality = +q.value;
      }
      const l = loopSel.value;
      if (l !== 'keep') out.loop = l === 'once' ? null : l === 'n' ? Math.max(1, Math.min(65535, Math.round(+box.querySelector('[name=repeats]').value || 1))) : 0;
      return out;
    },
    setQuality(v) {
      q.value = v;
      show();
    },
  };
}

// ---------------------------------------------------------------- progress
export function progressBox() {
  const bar = el('i');
  const label = el('span');
  const cancel = el('button', { type: 'button', class: 'btn small secondary' }, 'Cancel');
  const box = el('div', { class: 'progress', hidden: true, role: 'status' }, el('div', { class: 'bar' }, bar), el('p', {}, label, cancel));
  cancel.onclick = () => box.onCancel?.();
  return {
    el: box,
    show(text, done = 0, total = 0) {
      box.hidden = false;
      label.textContent = text;
      bar.style.width = total ? `${Math.round((100 * done) / total)}%` : '0';
    },
    hide() {
      box.hidden = true;
    },
    set onCancel(fn) {
      box.onCancel = fn;
    },
  };
}

export function errorBox() {
  const box = el('div', { class: 'note err', hidden: true, role: 'alert' });
  return {
    el: box,
    show(msg) {
      box.textContent = msg;
      box.hidden = false;
    },
    hide() {
      box.hidden = true;
    },
  };
}

// ---------------------------------------------------------------- results
export function resultBox({ current, verb = 'Made' }) {
  const img = el('img', { alt: 'Your new GIF' });
  const facts = el('ul', { class: 'facts' });
  const note = el('div', { class: 'note', hidden: true });
  const save = el('a', { class: 'btn', download: 'animation.gif' }, 'Download GIF');
  const saveOrig = el('a', { class: 'btn secondary', hidden: true }, 'Download the original');
  const next = el('div', { class: 'row' });
  const box = el(
    'section',
    { class: 'card', hidden: true, id: 'result' },
    el('h2', {}, 'Result'),
    el('div', { class: 'preview' }, el('figure', { class: 'shot' }, el('div', { class: 'frame' }, img))),
    facts,
    note,
    el('div', { class: 'actions' }, save, saveOrig),
    el('div', { class: 'next' }, el('p', {}, 'Keep editing this GIF:'), next),
  );
  let url;
  return {
    el: box,
    hide() {
      box.hidden = true;
    },
    // r: the worker's encode result; src: { file, size } of the input, when it was a GIF
    show(r, { name, src, keepOriginal = false }) {
      const blob = new Blob([r.gif], { type: 'image/gif' });
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(blob);
      img.src = url;
      save.href = url;
      save.download = name;
      const items = [['Size', fmt.bytes(blob.size)]];
      if (src?.size) {
        const d = 1 - blob.size / src.size;
        items[0].push(d > 0 ? el('span', { class: 'saving' }, ` (${Math.round(d * 100)}% smaller)`) : el('span', { class: 'worse' }, ` (${Math.round(-d * 100)}% bigger)`));
      }
      items.push(['Dimensions', `${r.w} x ${r.h}`], ['Frames', String(r.n)], ['Length', fmt.secs(r.duration)], ['Quality', `${r.quality}${r.scale < 1 ? `, shrunk to ${Math.round(r.scale * 100)}% to fit` : ''}`], ['Took', `${(r.ms / 1000).toFixed(1)} s`]);
      facts.replaceChildren(...items.map(([k, ...v]) => el('li', {}, `${k}: `, el('b', {}, ...v))));
      note.hidden = true;
      saveOrig.hidden = true;
      if (keepOriginal && src?.size && blob.size >= src.size) {
        note.className = 'note warn';
        note.textContent = `Your original file (${fmt.bytes(src.size)}) is already smaller than this at quality ${r.quality}. Keep the original, or try a lower quality.`;
        note.hidden = false;
        saveOrig.href = URL.createObjectURL(src.file);
        saveOrig.download = src.file.name || 'original.gif';
        saveOrig.hidden = false;
      }
      next.replaceChildren(
        ...TOOLS.filter(([t]) => t !== current).map(([t, label]) => el('button', { type: 'button', class: 'btn small secondary', onclick: () => openIn(t, [{ blob, name }]) }, label)),
      );
      box.hidden = false;
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  };
}

// ---------------------------------------------------------------- frame thumbnails
// Fills box with a button per frame (at most `max`, spread evenly), each with a small picture and
// the frame's number; onPick(i) gets the number, from 1. The pictures are drawn after it returns.
let thumbJob = 0;
export function frameThumbs(box, clip, onPick, max = 400) {
  box.replaceChildren();
  const job = ++thumbJob;
  const n = clip.frames.length;
  const step = Math.ceil(n / max);
  const tw = Math.min(120, clip.w);
  const th = Math.max(1, Math.round((tw * clip.h) / clip.w));
  let t = 0;
  for (let i = 0; i < n; i++) {
    const at = t;
    t += clip.delays[i];
    if (i % step) continue;
    const c = el('canvas', { width: tw, height: th });
    box.append(el('button', { type: 'button', 'data-i': i + 1, title: `Frame ${i + 1} at ${fmt.secs(at)}, shown for ${clip.delays[i] * 10} ms`, onclick: () => onPick(i + 1) }, c, `${i + 1}`));
  }
  (async () => {
    let full;
    for (const b of box.children) {
      if (job !== thumbJob) return;
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
  })();
}

// ---------------------------------------------------------------- the GIF tools
// def: {
//   current: 'compress',            // this tool's path, left out of "keep editing"
//   verb: 'Compress',               // button label
//   suffix: '-small',               // added to the output file name
//   quality: 70, sizeTarget: false, // output defaults
//   keepOriginal: false,            // offer the original when it is smaller
//   bigPreview: true,               // show the source GIF (tools with their own preview say false)
//   setup(ui), ops(ui) -> [operations], onChange?(ui)
//   run?(ui, { progress(text, done, total), signal }) // for tools whose result isn't a GIF: does
//                                   // the work and shows its own result, in place of ops and the
//                                   // encoder; output: false leaves out the GIF output settings
// }
// ui: { form, clip, file, $(sel), output, host }
export function gifTool(def) {
  const host = $('#tool');
  const tpl = $('#opts');
  const err = errorBox();
  const prog = progressBox();
  const result = def.run ? null : resultBox({ current: def.current }); // run() shows its own
  const output = def.output === false ? null : outputControls({ quality: def.quality ?? 90, sizeTarget: def.sizeTarget, exact: true, keepLoop: true });

  const srcImg = el('img', { alt: 'Your GIF' });
  const srcFacts = el('ul', { class: 'facts' });
  const srcWarn = el('div', { class: 'note warn', hidden: true });
  const srcView = el('div', { class: 'preview', hidden: def.bigPreview === false }, el('figure', { class: 'shot' }, el('div', { class: 'frame' }, srcImg)));
  const another = el('button', { type: 'button', class: 'btn small secondary' }, 'Use another file');
  const srcCard = el('section', { class: 'card', hidden: true }, srcView, srcFacts, srcWarn, el('div', { class: 'actions', style: 'margin-top:12px' }, another));
  const go = el('button', { class: 'btn big', type: 'submit' }, def.verb);
  const form = el('form', { class: 'card opts', hidden: true, novalidate: true });
  if (tpl) form.append(tpl.content.cloneNode(true));
  if (output) form.append(el('h3', {}, 'Output'), output.el);
  form.append(el('div', { class: 'actions' }, go));
  const drop = dropZone(
    { accept: 'image/gif,image/webp,image/png,image/apng,.gif', title: 'Drop a GIF here', hint: 'Animated WebP and PNG work too. Your file stays on this device.' },
    ([f]) => setSource(f),
  );
  host.append(drop, err.el, srcCard, form, prog.el, result?.el ?? '');

  const ui = { form, clip: null, file: null, $: (s) => form.querySelector(s), output, host };
  let srcUrl;

  async function load(file) {
    const kind = await sniff(file);
    if (!['gif', 'webp-anim', 'apng', 'image'].includes(kind)) {
      throw new Error(kind === 'video' ? 'That is a video. Use Video to GIF to turn it into a GIF first.' : "That file doesn't look like a GIF or an image.");
    }
    prog.onCancel = () => engine.cancel();
    return loadClip(file, kind, engine, (p) => prog.show(p.text, p.done, p.total));
  }

  async function setSource(file) {
    err.hide();
    result?.hide();
    prog.show('Reading the file');
    try {
      const clip = await load(file);
      ui.clip = clip;
      ui.file = file;
      if (srcUrl) URL.revokeObjectURL(srcUrl);
      srcUrl = URL.createObjectURL(file);
      srcImg.src = srcUrl;
      const dur = clip.delays.reduce((a, b) => a + b, 0);
      srcFacts.replaceChildren(
        ...[
          ['File', file.name || 'pasted image'],
          ['Size', fmt.bytes(file.size)],
          ['Dimensions', `${clip.w} x ${clip.h}`],
          ['Frames', String(clip.frames.length)],
          ['Length', fmt.secs(dur)],
          ['Looping', fmt.loop(clip.loop)],
        ].map(([k, v]) => el('li', {}, `${k}: `, el('b', {}, v))),
      );
      srcWarn.textContent = clip.warnings?.join(' ') || '';
      srcWarn.hidden = !clip.warnings?.length;
      drop.hidden = true;
      srcCard.hidden = false;
      form.hidden = false;
      def.setup?.(ui);
    } catch (e) {
      if (!e.cancelled) err.show(e.message);
    } finally {
      prog.hide();
    }
  }

  another.onclick = () => drop.querySelector('input').click();

  async function runOwn() {
    const stop = new AbortController();
    prog.onCancel = () => stop.abort();
    go.disabled = true;
    prog.show('Starting');
    try {
      await def.run(ui, { progress: (text, done, total) => prog.show(text, done, total), signal: stop.signal });
    } catch (x) {
      if (!stop.signal.aborted) err.show(x.message);
    } finally {
      go.disabled = false;
      prog.hide();
    }
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    err.hide();
    result?.hide();
    if (def.run) return runOwn();
    let ops, out;
    try {
      ops = def.ops(ui);
      out = output.read();
    } catch (x) {
      err.show(x.message);
      return;
    }
    const clip = ui.clip;
    if (clip.lost) {
      // the frames were in the worker when it stopped: read the file again
      try {
        prog.show('Reading the file again');
        Object.assign(clip, await load(ui.file), { lost: false });
      } catch (x) {
        prog.hide();
        err.show(x.message);
        return;
      }
    }
    const buffers = clip.frames.map((f) => f.buffer);
    go.disabled = true;
    prog.onCancel = () => engine.cancel();
    prog.show('Starting');
    try {
      const r = await engine.run('encode', { clip: { w: clip.w, h: clip.h, frames: buffers, delays: clip.delays, loop: clip.loop }, ops, out }, buffers, (p) => prog.show(p.text, p.done, p.total));
      clip.frames = r.frames.map((b) => new Uint8ClampedArray(b));
      result.show(r, { name: `${stem(ui.file.name)}${def.suffix}.gif`, src: { file: ui.file, size: ui.file.size }, keepOriginal: def.keepOriginal });
    } catch (x) {
      if (x.frames) clip.frames = x.frames.map((b) => new Uint8ClampedArray(b));
      else clip.lost = true;
      if (!x.cancelled) err.show(x.message);
    } finally {
      go.disabled = false;
      prog.hide();
    }
  };

  handedOver().then((f) => f && setSource(f[0]));
  return ui;
}
