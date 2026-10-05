// GIF to MP4 with the browser's own video encoder (WebCodecs), muxed by mp4mux.js.
import { gifTool, el, fmt, fact, stem } from '../app.js';
import { mp4 } from '../mp4mux.js';

// Quantizers: H.264 counts 0 to 51, VP9 (in WebCodecs) 0 to 63; lower is better.
const QP = { avc: { small: 31, standard: 26, high: 21 }, vp9: { small: 44, standard: 34, high: 24 } };
const BPP = { small: 0.1, standard: 0.2, high: 0.4 }; // bits per pixel per frame, where quantizers aren't offered
const KEY_EVERY = 200; // centiseconds between key frames, so players can seek

// H.264 levels: [level_idc, largest frame in macroblocks, macroblocks per second]
const AVC_LEVELS = [[30, 1620, 40500], [31, 3600, 108000], [32, 5120, 216000], [40, 8192, 245760], [42, 8704, 522240], [50, 22080, 589824], [51, 36864, 983040], [52, 36864, 2073600]];
// VP9 levels: [level, largest picture in pixels, pixels per second]
const VP9_LEVELS = [[10, 36864, 829440], [11, 73728, 2764800], [20, 122880, 4608000], [21, 245760, 9216000], [30, 552960, 20736000], [31, 983040, 36864000], [40, 2228224, 83558400], [41, 2228224, 160432128], [50, 8912896, 311951360], [51, 8912896, 588251136], [52, 8912896, 1176502272], [60, 35651584, 1176502272]];

// RGB to limited-range YCbCr: [Y from R, G, B; Cb from R, G, B; Cr from R, G, B]. Chrome writes the
// colour matrix into H.264 streams as it is given, but always marks VP9 streams as BT.709, so each
// codec gets the matrix its stream will say; with BT.601, H.264 plays back within 2 levels of the
// GIF's colours in Chrome.
const MATRIX = {
  smpte170m: { code: 6, k: [0.256788, 0.504129, 0.097906, -0.148223, -0.290993, 0.439216, 0.439216, -0.367788, -0.071427] },
  bt709: { code: 1, k: [0.182586, 0.614231, 0.062007, -0.100644, -0.338572, 0.439216, 0.439216, -0.398942, -0.040274] },
};

const resultCard = el('section', { class: 'card', hidden: true, id: 'result' });
let url;

const ui = gifTool({
  current: 'gif-to-mp4',
  verb: 'Convert to MP4',
  output: false,
  setup(ui) {
    resultCard.hidden = true;
    ui.$('[data-bg]').hidden = !transparent(ui.clip);
    summary();
  },
  async run(ui, { progress, signal }) {
    resultCard.hidden = true;
    const t0 = performance.now();
    const q = ui.$('[name=q]:checked').value;
    const r = await toMp4(ui.clip, { q, repeat: repeat(), bg: ui.$('[name=bg]').value }, progress, signal);
    show(r, performance.now() - t0);
  },
});
ui.host.append(resultCard);

const repeat = () => +ui.$('[name=repeat]:checked').value;
const even = (n) => n + (n & 1);

function transparent(clip) {
  for (const f of clip.frames) for (let i = 3; i < f.length; i += 4) if (f[i] < 255) return true;
  return false;
}

function summary() {
  if (!ui.clip) return;
  const { w, h, delays } = ui.clip;
  const len = delays.reduce((a, b) => a + b, 0) * repeat();
  const pad = w !== even(w) || h !== even(h) ? ' (videos need even sizes, so the edge is repeated by a pixel)' : '';
  ui.$('[data-summary]').textContent = `The video will be ${even(w)} x ${even(h)}${pad} and ${fmt.secs(len)} long.`;
}
for (const r of ui.form.querySelectorAll('[name=repeat]')) r.onchange = summary;

const hex = (n) => n.toString(16).padStart(2, '0');
function avcLevel(w, h, fps) {
  const mw = Math.ceil(w / 16);
  const mh = Math.ceil(h / 16);
  for (const [level, fs, rate] of AVC_LEVELS) {
    const side = Math.sqrt(fs * 8);
    if (mw * mh <= fs && mw <= side && mh <= side && mw * mh * fps <= rate) return level;
  }
  return null;
}
function vp9Level(w, h, fps) {
  for (const [level, size, rate] of VP9_LEVELS) if (w * h <= size && w * h * fps <= rate) return level;
  return 62;
}

// The first encoder setting the browser supports: H.264 (High, Main, then Constrained Baseline
// profile), then VP9; with a fixed quantizer where offered, else a bitrate.
async function pick(w, h, delays, q) {
  if (typeof VideoEncoder === 'undefined') throw new Error("This browser can't make videos. Recent Chrome, Edge, Safari and Firefox can.");
  const fps = 100 / Math.min(...delays); // the fastest a frame changes
  const avg = (100 * delays.length) / delays.reduce((a, b) => a + b, 0);
  const base = { width: w, height: h, framerate: avg, latencyMode: 'quality' };
  const tries = [];
  const al = avcLevel(w, h, fps);
  if (al) for (const p of ['6400', '4d40', '42e0']) tries.push({ kind: 'avc', profile: p, config: { ...base, codec: `avc1.${p}${hex(al)}`, avc: { format: 'avc' } } });
  const vl = vp9Level(w, h, fps);
  tries.push({ kind: 'vp9', level: vl, config: { ...base, codec: `vp09.00.${String(vl).padStart(2, '0')}.08` } });
  for (const t of tries) {
    for (const mode of ['quantizer', 'variable']) {
      const config = { ...t.config, bitrateMode: mode };
      if (mode === 'variable') config.bitrate = Math.max(150e3, Math.round(w * h * avg * BPP[q]));
      try {
        if ((await VideoEncoder.isConfigSupported(config)).supported) return { ...t, mode, config };
      } catch {
        // an invalid combination for this browser: try the next
      }
    }
  }
  throw new Error(`This browser can't make a ${w} x ${h} video. Make the GIF smaller with Resize first, or try Chrome or Edge.`);
}

// RGBA over the background colour, as I420 with the matrix k, padded to W x H by repeating the
// last column and row.
function toI420(src, w, h, W, H, bg, k, out) {
  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(y, h - 1);
    for (let x = 0; x < W; x++) {
      const i = (sy * w + Math.min(x, w - 1)) * 4;
      const o = (y * W + x) * 3;
      const a = src[i + 3];
      if (a === 255) {
        rgb[o] = src[i];
        rgb[o + 1] = src[i + 1];
        rgb[o + 2] = src[i + 2];
      } else {
        for (let c = 0; c < 3; c++) rgb[o + c] = Math.round((src[i + c] * a + bg[c] * (255 - a)) / 255);
      }
    }
  }
  const cw = W / 2;
  const U = W * H;
  const V = U + cw * (H / 2);
  for (let i = 0, o = 0; i < W * H; i++, o += 3) out[i] = Math.round(16 + k[0] * rgb[o] + k[1] * rgb[o + 1] + k[2] * rgb[o + 2]);
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      let r = 0, g = 0, b = 0;
      for (const o of [(y * W + x) * 3, (y * W + x + 1) * 3, ((y + 1) * W + x) * 3, ((y + 1) * W + x + 1) * 3]) {
        r += rgb[o];
        g += rgb[o + 1];
        b += rgb[o + 2];
      }
      r /= 4;
      g /= 4;
      b /= 4;
      const c = (y / 2) * cw + x / 2;
      out[U + c] = Math.round(128 + k[3] * r + k[4] * g + k[5] * b);
      out[V + c] = Math.round(128 + k[6] * r + k[7] * g + k[8] * b);
    }
  }
}

async function toMp4(clip, { q, repeat, bg }, progress, signal) {
  const { w, h, frames, delays } = clip;
  const W = even(w);
  const H = even(h);
  const enc = await pick(W, H, delays, q);
  const back = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
  const matrix = enc.kind === 'avc' ? 'smpte170m' : 'bt709';
  const chunks = [];
  let description = null;
  let failed = null;
  const encoder = new VideoEncoder({
    output(chunk, meta) {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ data, ts: chunk.timestamp, key: chunk.type === 'key' });
      const d = meta?.decoderConfig?.description;
      if (d && !description) description = new Uint8Array(ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d.slice(0));
    },
    error(e) {
      failed = e;
    },
  });
  try {
    encoder.configure(enc.config);
    const buf = new Uint8Array(W * H * 1.5);
    const total = frames.length * repeat;
    let t = 0; // centiseconds
    let lastKey = -Infinity;
    for (let k = 0; k < total; k++) {
      if (signal.aborted) throw new Error('Cancelled.');
      if (failed) throw failed;
      const i = k % frames.length;
      if (!frames[i].byteLength) throw new Error('The frames are busy; try again.');
      toI420(frames[i], w, h, W, H, back, MATRIX[matrix].k, buf);
      const frame = new VideoFrame(buf, {
        format: 'I420',
        codedWidth: W,
        codedHeight: H,
        timestamp: t * 10000, // microseconds
        duration: delays[i] * 10000,
        colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix, fullRange: false },
      });
      const opts = { keyFrame: t - lastKey >= KEY_EVERY };
      if (opts.keyFrame) lastKey = t;
      if (enc.mode === 'quantizer') opts[enc.kind] = { quantizer: QP[enc.kind][q] };
      encoder.encode(frame, opts);
      frame.close();
      t += delays[i];
      progress(`Encoding frame ${k + 1} of ${total}`, k + 1, total);
      while (encoder.encodeQueueSize > 2 && !failed) await new Promise((ok) => setTimeout(ok, 1));
    }
    progress('Finishing the video', total, total);
    await encoder.flush();
    if (failed) throw failed;
    const end = t * 10000;
    // durations from the timestamps, in milliseconds (the MP4's time unit)
    const samples = chunks.map((c, j) => {
      const next = j + 1 < chunks.length ? chunks[j + 1].ts : end;
      if (next <= c.ts) throw new Error("The browser's video encoder reordered the frames, which this tool can't store.");
      return { data: c.data, key: c.key, duration: Math.round((next - c.ts) / 1000) };
    });
    if (enc.kind === 'avc' && !description) throw new Error("The browser's video encoder didn't describe its H.264 stream.");
    const colr = { primaries: 1, transfer: 1, matrix: MATRIX[matrix].code, fullRange: false };
    const blob = mp4({ codec: enc.kind, width: W, height: H, timescale: 1000, description, vp9: { profile: 0, level: enc.level }, colr, samples });
    return { blob, enc, w: W, h: H, frames: samples.length, cs: t };
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
}

function show(r, ms) {
  if (url) URL.revokeObjectURL(url);
  url = URL.createObjectURL(r.blob);
  const gif = ui.file.size;
  const d = 1 - r.blob.size / gif;
  const codec = r.enc.kind === 'avc' ? `H.264 (${{ 6400: 'High', '4d40': 'Main', '42e0': 'Baseline' }[r.enc.profile]} profile)` : 'VP9';
  const facts = [
    ['Size', fmt.bytes(r.blob.size), d > 0 ? el('span', { class: 'saving' }, ` (${Math.round(d * 100)}% smaller than the GIF)`) : el('span', { class: 'worse' }, ` (${Math.round(-d * 100)}% bigger than the GIF)`)],
    ['Dimensions', `${r.w} x ${r.h}`],
    ['Frames', String(r.frames)],
    ['Length', fmt.secs(r.cs)],
    ['Video', codec],
    ['Took', `${(ms / 1000).toFixed(1)} s`],
  ];
  const video = el('video', { src: url, autoplay: true, loop: true, muted: true, playsinline: true, controls: true });
  video.muted = true;
  resultCard.replaceChildren(
    el('h2', {}, 'Result'),
    el('div', { class: 'preview' }, el('figure', { class: 'shot' }, el('div', { class: 'frame' }, video))),
    el('ul', { class: 'facts' }, ...facts.map(([k, ...v]) => fact(k, ...v))),
    ...(r.enc.kind === 'vp9' ? [el('div', { class: 'note warn' }, "This browser can't make H.264 video, so this MP4 uses VP9. It plays in browsers and on most phones, but some apps may not accept it; Chrome, Edge or Safari make H.264.")] : []),
    el('div', { class: 'actions', style: 'margin-top:12px' }, el('a', { class: 'btn', href: url, download: `${stem(ui.file.name)}.mp4` }, 'Download MP4')),
  );
  resultCard.hidden = false;
  resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
