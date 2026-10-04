// Runs inside the Chromium page: decodes one GIF with WebCodecs ImageDecoder and with
// /site/assets/gifdecode.js and compares every frame (RGBA) and every delay.
import * as GD from '/site/assets/gifdecode.js';

function px(d, o) { return [d[o], d[o + 1], d[o + 2], d[o + 3]]; }

// Alpha must match everywhere; RGB is compared where alpha is non-zero (GIF alpha is 0 or 255).
function diffFrames(a, b, W) {
  const a32 = new Uint32Array(a.buffer, a.byteOffset, a.length >> 2);
  const b32 = new Uint32Array(b.buffer, b.byteOffset, b.length >> 2);
  const n = a32.length;
  let count = 0, first = -1;
  for (let i = 0; i < n; i++) {
    if (a32[i] === b32[i]) continue;
    const o = i * 4;
    if (a[o + 3] === 0 && b[o + 3] === 0) continue;
    if (first < 0) first = i;
    count++;
  }
  if (first < 0) return null;
  return { x: first % W, y: (first / W) | 0, chrome: px(a, first * 4), ours: px(b, first * 4), count };
}

function selfCheck(rgba) {
  // Our fully transparent pixels must be exactly 0,0,0,0 and alpha must be 0 or 255.
  for (let o = 3; o < rgba.length; o += 4) {
    const a = rgba[o];
    if (a === 0) { if (rgba[o - 3] | rgba[o - 2] | rgba[o - 1]) return `pixel ${(o - 3) / 4} is transparent but not 0,0,0,0`; }
    else if (a !== 255) return `pixel ${(o - 3) / 4} has alpha ${a}`;
  }
  return null;
}

export async function compareOne(url, { timing = false } = {}) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch ${url}: HTTP ${resp.status}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const out = { url, size: bytes.length, status: 'pass', notes: [], chrome: {}, ours: {} };

  // ---- ours
  let ours = null, oursErr = null;
  const t0 = performance.now();
  try { ours = GD.decodeGif(bytes); } catch (e) { oursErr = e; }
  const t1 = performance.now();
  if (ours) {
    out.ours = { frames: ours.frames.length, width: ours.width, height: ours.height, loopCount: ours.loopCount, ms: t1 - t0,
      incomplete: ours.complete.map((c, i) => c ? -1 : i).filter(i => i >= 0), warnings: ours.warnings };
  } else {
    out.ours = { error: oursErr.message, ms: t1 - t0 };
  }

  // ---- chrome
  let dec, chromeOpenErr = null, frameCount = 0, rep = null;
  const t2 = performance.now();
  try {
    dec = new ImageDecoder({ data: bytes, type: 'image/gif' });
    await dec.tracks.ready;
    frameCount = dec.tracks.selectedTrack.frameCount;
    rep = dec.tracks.selectedTrack.repetitionCount;
  } catch (e) { chromeOpenErr = String(e && e.message || e); }
  out.chrome = { frames: frameCount, repetitionCount: rep, error: chromeOpenErr };

  const fail = (msg) => { if (out.status !== 'fail') { out.status = 'fail'; out.reason = msg; } out.notes.push(msg); };

  if (chromeOpenErr || frameCount === 0) {
    // Chrome cannot show the file at all.
    if (!ours) { out.status = 'pass'; out.notes.push('both reject: ' + (chromeOpenErr || 'no frames') + ' / ' + oursErr.message); }
    else if (ours.complete.every(c => !c)) { out.status = 'pass-chrome-rejects'; out.notes.push('Chrome rejects the file; ours returns only incomplete frames'); }
    else fail('Chrome rejects the file (' + (chromeOpenErr || 'no frames') + ') but ours decodes complete frames');
    try { dec && dec.close(); } catch {}
    return out;
  }
  if (!ours) {
    // Decided after decoding Chrome's frames: fine if Chrome cannot show any frame either.
  } else if (ours.frames.length !== frameCount) {
    fail(`frame count: chrome ${frameCount}, ours ${ours.frames.length}`);
  }
  if (ours) {
    // Loop count: Chrome repetitionCount is Infinity for 0 (forever), n for n, 0 when absent (multi-frame).
    const expect = ours.loopCount === null ? (frameCount > 1 ? 0 : Infinity) : ours.loopCount === 0 ? Infinity : ours.loopCount;
    if (rep !== expect) fail(`loop count: chrome repetitionCount ${rep}, ours loopCount ${ours.loopCount}`);
  }

  let canvas = null, ctx = null, chromeMs = 0, chromeFailed = 0, partialCompared = 0;
  const n = frameCount;
  const frameReport = [];
  for (let i = 0; i < n; i++) {
    const ts = performance.now();
    let r = null, err = null, partial = false;
    try { r = await dec.decode({ frameIndex: i }); }
    catch (e) {
      err = String(e && e.message || e);
      try { r = await dec.decode({ frameIndex: i, completeFramesOnly: false }); partial = true; } catch { r = null; }
    }
    let data = null, w = 0, h = 0, dur = null;
    if (r && partial) {
      // Partial (rejected) frames: Chrome keeps the alpha type of the frame it started from, so
      // such a frame can claim to be opaque (format BGRX) while holding transparent pixels, and
      // drawing it onto a reused canvas is ill-defined (clearRect gets elided). Compare the raw
      // decoded bytes instead.
      const im = r.image;
      w = im.displayWidth; h = im.displayHeight; dur = im.duration;
      const raw = new Uint8Array(im.allocationSize());
      await im.copyTo(raw);
      const bgr = im.format.startsWith('BGR');
      data = new Uint8ClampedArray(w * h * 4);
      for (let o = 0; o < data.length; o += 4) {
        data[o] = raw[o + (bgr ? 2 : 0)]; data[o + 1] = raw[o + 1]; data[o + 2] = raw[o + (bgr ? 0 : 2)]; data[o + 3] = raw[o + 3];
      }
      im.close();
    } else if (r) {
      const im = r.image;
      w = im.displayWidth; h = im.displayHeight; dur = im.duration;
      if (!canvas || canvas.width !== w || canvas.height !== h) {
        canvas = new OffscreenCanvas(w, h);
        ctx = canvas.getContext('2d', { willReadFrequently: true });
      }
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(im, 0, 0);
      data = ctx.getImageData(0, 0, w, h).data;
      im.close();
    }
    chromeMs += performance.now() - ts;
    if (err) chromeFailed++;
    if (!ours) { frameReport.push({ i, chrome: data ? 'shown' : 'none' }); continue; }
    if (i >= ours.frames.length) continue;
    const ourComplete = ours.complete[i];
    if (!err && !ourComplete) fail(`frame ${i}: Chrome decodes it but ours marks it incomplete`);
    if (err && ourComplete) fail(`frame ${i}: Chrome rejects it (${err}) but ours marks it complete`);
    if (!data) { frameReport.push({ i, chrome: 'none' }); continue; }
    if (w !== ours.width || h !== ours.height) { fail(`size: chrome ${w}x${h}, ours ${ours.width}x${ours.height}`); break; }
    if (!partial && dur !== ours.rawDelays[i] * 10000) fail(`frame ${i}: delay chrome ${dur}us, ours raw ${ours.rawDelays[i]}cs`);
    const sc = selfCheck(ours.frames[i]);
    if (sc) fail(`frame ${i}: ${sc}`);
    const d = diffFrames(data, ours.frames[i], w);
    if (partial) partialCompared++;
    if (d) {
      fail(`frame ${i}${partial ? ' (partial)' : ''}: ${d.count} pixels differ, first at (${d.x},${d.y}) chrome ${d.chrome} ours ${d.ours}`);
      out.firstDiff = { frame: i, partial, ...d };
    }
  }
  try { dec.close(); } catch {}
  if (!ours) {
    if (chromeFailed === n && !frameReport.some(f => f.chrome !== 'none')) {
      out.status = 'pass';
      out.notes.push(`both reject: Chrome cannot decode any of its ${n} frame(s); ours throws: ${oursErr.message}`);
      return out;
    }
    fail('ours throws: ' + oursErr.message + ' but Chrome shows frames');
  }
  out.chrome.ms = performance.now() - t2;
  out.chrome.decodeMs = chromeMs;
  out.chrome.failedFrames = chromeFailed;
  out.chrome.partialCompared = partialCompared;
  if (out.status === 'pass' && chromeFailed) out.status = 'pass-with-damaged-frames';
  return out;
}
