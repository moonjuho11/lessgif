// Reading what people drop in: GIFs (our own decoder, in the worker), animated WebP and PNG
// (the browser's ImageDecoder where it has one), still images, and videos (seeking a <video>).
import { delaysForFps } from './lessgif.js';
import { MIN_DELAY } from './ops.js';

// Frames are kept as RGBA in memory, so very long or large clips can exhaust a phone's memory.
// The budget is in pixels across all frames, scaled to the device where the browser says.
export function pixelBudget() {
  const gb = navigator.deviceMemory || 4;
  return Math.min(200e6, gb * 20e6);
}

export function checkBudget(w, h, n) {
  const px = w * h * n;
  if (px > pixelBudget()) {
    const mb = Math.round((px * 4) / 1e6);
    throw new Error(
      `That's ${n} frames at ${w}x${h}, which needs about ${mb} MB of memory, more than this device should use. Try a shorter clip, fewer frames per second or a smaller size, or use the lessgif app.`,
    );
  }
}

async function head(file, n) {
  return new Uint8Array(await file.slice(0, n).arrayBuffer());
}
const text = (b, o, s) => String.fromCharCode(...b.subarray(o, o + s.length)) === s;

// 'gif' | 'apng' | 'webp-anim' | 'image' | 'video' | null
export async function sniff(file) {
  const b = await head(file, 64);
  if (text(b, 0, 'GIF8')) return 'gif';
  if (b[0] === 0x89 && text(b, 1, 'PNG')) {
    // animated PNGs have an acTL chunk before the first IDAT
    const big = await head(file, 1 << 16);
    for (let i = 8; i + 8 <= big.length; ) {
      const len = ((big[i] << 24) | (big[i + 1] << 16) | (big[i + 2] << 8) | big[i + 3]) >>> 0;
      if (text(big, i + 4, 'acTL')) return 'apng';
      if (text(big, i + 4, 'IDAT')) break;
      i += len + 12;
    }
    return 'image';
  }
  if (text(b, 0, 'RIFF') && text(b, 8, 'WEBP')) return text(b, 12, 'VP8X') && b[20] & 2 ? 'webp-anim' : 'image';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image';
  if (text(b, 4, 'ftyp') || (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)) return 'video';
  if (file.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv|ogv|avi|3gp)$/i.test(file.name || '')) return 'video';
  if (file.type.startsWith('image/')) return 'image';
  return null;
}

function canvas2d(w, h) {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  return c.getContext('2d', { willReadFrequently: true });
}

// A still image as a one-frame clip.
export async function loadStill(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error(`This browser can't open ${file.name || 'that image'}. PNG, JPEG, WebP and GIF work everywhere.`);
  }
  const { width: w, height: h } = bmp;
  const ctx = canvas2d(w, h);
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return { w, h, frames: [ctx.getImageData(0, 0, w, h).data], delays: [10], loop: 0, warnings: [] };
}

// Animated WebP or PNG through WebCodecs' ImageDecoder (Chrome, Edge, recent Firefox and Safari).
async function loadWithImageDecoder(file, type, onProgress) {
  if (!('ImageDecoder' in self) || !(await ImageDecoder.isTypeSupported(type))) {
    const clip = await loadStill(file);
    clip.warnings.push("This browser can only read the first frame of animated WebP and PNG files. Chrome and Edge read all of them.");
    return clip;
  }
  const dec = new ImageDecoder({ data: await file.arrayBuffer(), type });
  await dec.tracks.ready;
  const track = dec.tracks.selectedTrack;
  const n = track.frameCount;
  const frames = [];
  const delays = [];
  let ctx;
  for (let i = 0; i < n; i++) {
    const { image } = await dec.decode({ frameIndex: i });
    if (!ctx) {
      ctx = canvas2d(image.displayWidth, image.displayHeight);
      checkBudget(image.displayWidth, image.displayHeight, n);
    }
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.drawImage(image, 0, 0);
    frames.push(ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data);
    delays.push(Math.max(MIN_DELAY, Math.round((image.duration ?? 100000) / 10000)));
    image.close();
    onProgress?.({ text: `Reading frame ${i + 1} of ${n}`, done: i + 1, total: n });
  }
  dec.close();
  const rep = track.repetitionCount;
  return { w: ctx.canvas.width, h: ctx.canvas.height, frames, delays, loop: rep === Infinity ? 0 : rep || null, warnings: [] };
}

// Any picture input as a clip of RGBA frames.
export async function loadClip(file, kind, engine, onProgress) {
  if (kind === 'gif') {
    const bytes = await file.arrayBuffer();
    const r = await engine.run('decode', { bytes, budget: pixelBudget() }, [bytes], onProgress);
    return { ...r, frames: r.frames.map((b) => new Uint8ClampedArray(b)) };
  }
  if (kind === 'apng') return loadWithImageDecoder(file, 'image/png', onProgress);
  if (kind === 'webp-anim') return loadWithImageDecoder(file, 'image/webp', onProgress);
  if (kind === 'image') return loadStill(file);
  throw new Error("That file isn't an image this tool can read. Try a GIF, PNG, JPEG or WebP.");
}

const once = (el, ev, ms = 15000) =>
  new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error('The video stopped responding while reading frames.')), ms);
    el.addEventListener(
      ev,
      () => {
        clearTimeout(t);
        ok();
      },
      { once: true },
    );
  });

// A <video> element for the file, with metadata loaded and a finite duration.
export async function openVideo(file) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = URL.createObjectURL(file);
  await new Promise((ok, fail) => {
    v.onloadedmetadata = ok;
    v.onerror = () => fail(new Error("This browser can't play that video. MP4 (H.264) and WebM work in every browser; other formats may need the lessgif app."));
  });
  if (!Number.isFinite(v.duration)) {
    // recordings from MediaRecorder often lack a duration until the end has been seen
    v.currentTime = 1e9;
    await once(v, 'seeked').catch(() => {});
    v.currentTime = 0;
    await once(v, 'seeked').catch(() => {});
  }
  if (!v.videoWidth || !v.videoHeight) throw new Error("That file has no video picture this browser can show.");
  return v;
}

// Chrome occasionally fires 'seeked' before the new frame can be drawn (about one frame in a
// few hundred came out as the previous one), so where the browser can say when the frame is
// ready, wait for that too.
async function seek(v, t) {
  if (Math.abs(v.currentTime - t) < 1e-4 && v.readyState >= 2) return;
  const shown = 'requestVideoFrameCallback' in v ? new Promise((ok) => v.requestVideoFrameCallback(ok)) : null;
  const done = once(v, 'seeked');
  v.currentTime = t;
  await done;
  if (shown) await Promise.race([shown, new Promise((ok) => setTimeout(ok, 250))]);
}

// Frames from start to end (seconds) at fps, drawn at w x h. (Several <video> elements seeking
// in parallel were tried: Chrome still does one seek at a time, about 50 ms each.)
export async function videoFrames(v, { start, end, fps, w, h, onProgress, signal }) {
  const n = Math.max(1, Math.round((end - start) * fps));
  checkBudget(w, h, n);
  const ctx = canvas2d(w, h);
  ctx.imageSmoothingQuality = 'high';
  const frames = [];
  for (let i = 0; i < n; i++) {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled.'), { cancelled: true });
    // a hair past the frame's start, so rounding never lands on the frame before
    await seek(v, Math.min(start + i / fps + 1e-3, Math.max(0, v.duration - 1e-3)));
    ctx.drawImage(v, 0, 0, w, h);
    frames.push(ctx.getImageData(0, 0, w, h).data);
    onProgress?.({ text: `Reading video frame ${i + 1} of ${n}`, done: i + 1, total: n });
  }
  return { w, h, frames, delays: delaysForFps(n, fps), loop: 0, warnings: [] };
}
