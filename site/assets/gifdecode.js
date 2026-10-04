// gifdecode.js — dependency-free animated GIF decoder that reproduces what Chromium shows.
//
// Works as a plain ES module in a page, in a module worker and in Node (no DOM use).
//
// Chromium (M141) decodes GIFs with Skia's SkWuffsCodec (Wuffs v0.3 GIF + LZW decoders) and
// composites frames in Blink's SkiaImageDecoderBase. This module follows the same rules:
//  * canvas = logical screen enlarged to contain the first frame; starts fully transparent
//    (the background colour index is ignored);
//  * colour tables are padded to 256 entries with opaque black, so pixel indices beyond the
//    palette (and frames with no colour table at all) draw opaque black; the transparent index
//    is transparent even when it is beyond the palette;
//  * LZW exactly as Wuffs: min code size 0..8 accepted (>8 is an error), no leading clear code
//    needed, codes above the next free entry are errors, a full 4096-entry table keeps going
//    without growing, data after the frame is complete is ignored (even invalid codes);
//  * disposal 2 clears the frame rectangle (clipped to the canvas) to transparent, 3 and 4
//    restore the canvas from before the frame, 0/1/5/6/7 keep;
//  * a frame whose data is short or broken is not shown by Chromium's ImageDecoder; here it is
//    still returned (what could be decoded, drawn the way Chromium draws a partial frame) with
//    complete[i] = false and a warning;
//  * delays: rawDelays are the stored centiseconds; delays are what Chrome plays (0 or 1 cs -> 10).
//
// Exports:
//   parseGif(bytes)                      -> structure only (cheap, no LZW)
//   decodeGif(bytes, { onFrame })        -> every composited frame (fresh RGBA array each)
//   decodeFrames(bytesOrParsed)          -> generator yielding composited frames one at a time
// Every RGBA array handed out (decodeGif frames, onFrame, decodeFrames) is a new
// width*height*4 Uint8ClampedArray owned by the caller: the decoder keeps private copies of the
// canvases later frames build on, so frames may be modified or transferred right away.
//   decodeFrameIndices(bytesOrParsed, i) -> the raw palette indices of one frame (not composited)

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const OPAQUE_BLACK = LITTLE_ENDIAN ? 0xff000000 : 0x000000ff;

export const DISPOSE_KEEP = 0;
export const DISPOSE_BACKGROUND = 2;
export const DISPOSE_PREVIOUS = 3;

// ---------------------------------------------------------------------------------------------
// Input helpers

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof SharedArrayBuffer !== 'undefined' && input instanceof SharedArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('GIF data must be a Uint8Array, ArrayBuffer or typed array view.');
}

function sniffOtherFormat(b) {
  const n = b.length;
  if (n >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'a PNG image';
  if (n >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'a JPEG image';
  if (n >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'a WebP image';
  if (n >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'an MP4/MOV/AVIF/HEIC file';
  if (n >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'a WebM/MKV video';
  if (n >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'a BMP image';
  if (n >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a))) return 'a TIFF image';
  if (n >= 5 && b[0] === 0x3c) return 'an HTML/XML/SVG text file';
  return null;
}

function gifError(message, code) {
  const e = new Error(message);
  e.name = 'GifDecodeError';
  e.code = code;
  return e;
}

// ---------------------------------------------------------------------------------------------
// parseGif: structure only.

/**
 * Parse the structure of a GIF without decoding pixels.
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} input
 * @returns {{width:number,height:number,screenWidth:number,screenHeight:number,loopCount:number|null,
 *   version:string,backgroundIndex:number,globalPalette:Uint8Array|null,frames:object[],warnings:string[]}}
 */
export function parseGif(input) {
  const bytes = toBytes(input);
  const n = bytes.length;
  const warnings = [];

  // Header: exactly "GIF87a" or "GIF89a" (Wuffs rejects anything else).
  if (n < 6 || bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x38 ||
      (bytes[4] !== 0x37 && bytes[4] !== 0x39) || bytes[5] !== 0x61) {
    if (n === 0) throw gifError('The file is empty.', 'empty');
    const other = sniffOtherFormat(bytes);
    if (n < 6 && bytes[0] === 0x47) throw gifError(`The file is only ${n} bytes long, too short to be a GIF.`, 'truncated');
    throw gifError(other ? `This is not a GIF file: it looks like ${other}.` :
      'This is not a GIF file (it does not start with "GIF87a" or "GIF89a").', 'not-gif');
  }
  const version = bytes[4] === 0x37 ? '87a' : '89a';
  if (n < 13) throw gifError(`The GIF file is cut off inside its header (only ${n} bytes).`, 'truncated');

  const screenWidth = bytes[6] | (bytes[7] << 8);
  const screenHeight = bytes[8] | (bytes[9] << 8);
  const lsdFlags = bytes[10];
  const backgroundIndex = bytes[11];
  let pos = 13;
  let globalPalette = null;
  if (lsdFlags & 0x80) {
    const len = 3 * (2 << (lsdFlags & 7));
    if (pos + len > n) throw gifError('The GIF file is cut off inside its global colour table.', 'truncated');
    globalPalette = bytes.slice(pos, pos + len);
    pos += len;
  }

  const frames = [];
  let loopCount = null;
  // Graphic Control state (reset after every frame, last extension before an image wins).
  let gcHasTrans = false, gcTrans = 0, gcRawDisposal = 0, gcDelay = 0, gcSeen = false;
  let width = screenWidth, height = screenHeight;
  let end = null; // why parsing stopped
  let fatal = null; // structural error that makes Chromium stop reading

  const eof = (where) => { end = { kind: 'eof', where, offset: n }; };

  // Skip a chain of data sub-blocks. Returns false when the file ends first.
  const skipBlocks = () => {
    for (;;) {
      if (pos >= n) return false;
      const bs = bytes[pos++];
      if (bs === 0) return true;
      pos += bs;
    }
  };

  outer:
  for (;;) {
    if (pos >= n) { eof('between blocks'); break; }
    const blockStart = pos;
    const b = bytes[pos++];
    if (b === 0x21) {
      if (pos >= n) { eof('extension'); break; }
      const label = bytes[pos++];
      if (label === 0xf9) {
        // Graphic Control Extension: Wuffs insists on block size 4 and a 0 terminator.
        if (pos >= n) { eof('graphic control extension'); break; }
        const size = bytes[pos++];
        if (size !== 4) {
          fatal = `graphic control extension at byte ${blockStart} has block size ${size} instead of 4`;
          break;
        }
        if (pos + 5 > n) { eof('graphic control extension'); break; }
        const flags = bytes[pos];
        gcHasTrans = (flags & 1) !== 0;
        gcRawDisposal = (flags >> 2) & 7;
        gcDelay = bytes[pos + 1] | (bytes[pos + 2] << 8);
        gcTrans = bytes[pos + 3];
        gcSeen = true;
        pos += 4;
        if (bytes[pos++] !== 0) {
          fatal = `graphic control extension at byte ${blockStart} is longer than 4 bytes`;
          break;
        }
      } else if (label === 0xff) {
        // Application extension (Wuffs decode_ae).
        if (pos >= n) { eof('application extension'); break; }
        let bs = bytes[pos++];
        if (bs === 0) continue; // empty: done, no further sub-blocks are read
        if (bs !== 11) {
          pos += bs;
        } else {
          if (pos + 11 > n) { eof('application extension'); break; }
          let netscape = true, animexts = true;
          const NS = 'NETSCAPE2.0', AX = 'ANIMEXTS1.0';
          for (let k = 0; k < 11; k++) {
            const c = bytes[pos + k];
            if (c !== NS.charCodeAt(k)) netscape = false;
            if (c !== AX.charCodeAt(k)) animexts = false;
          }
          pos += 11;
          if (netscape || animexts) {
            if (pos >= n) { eof('application extension'); break; }
            bs = bytes[pos++];
            if (bs !== 3) {
              pos += bs;
            } else {
              if (pos >= n) { eof('application extension'); break; }
              const id = bytes[pos++];
              if (id !== 1) {
                pos += 2;
              } else {
                if (pos + 2 > n) { eof('application extension'); break; }
                loopCount = bytes[pos] | (bytes[pos + 1] << 8);
                pos += 2;
              }
            }
          }
        }
        if (!skipBlocks()) { eof('application extension'); break; }
      } else {
        // Comment, plain text and unknown extensions are skipped.
        if (!skipBlocks()) { eof(label === 0xfe ? 'comment extension' : label === 0x01 ? 'plain text extension' : 'extension'); break; }
      }
    } else if (b === 0x2c) {
      // Image Descriptor. Chromium counts the frame as soon as its position and size are read.
      if (pos + 8 > n) { eof('image descriptor'); break; }
      const left = bytes[pos] | (bytes[pos + 1] << 8);
      const top = bytes[pos + 2] | (bytes[pos + 3] << 8);
      const fw = bytes[pos + 4] | (bytes[pos + 5] << 8);
      const fh = bytes[pos + 6] | (bytes[pos + 7] << 8);
      pos += 8;
      if (frames.length === 0) {
        if (left + fw > width) width = left + fw;
        if (top + fh > height) height = top + fh;
      }
      const dispose = gcRawDisposal === 2 ? DISPOSE_BACKGROUND : (gcRawDisposal === 3 || gcRawDisposal === 4) ? DISPOSE_PREVIOUS : DISPOSE_KEEP;
      const frame = {
        index: frames.length,
        left, top, width: fw, height: fh,
        delay: gcDelay,
        disposal: gcRawDisposal,       // raw 3-bit field from the GIF
        dispose,                       // how Chrome treats it: 0 keep, 2 background, 3 previous
        transparentIndex: gcHasTrans ? gcTrans : -1,
        hasGraphicControl: gcSeen,
        interlaced: false,
        localPalette: false,
        palette: globalPalette || new Uint8Array(0),
        lzwMinCodeSize: -1,
        offset: blockStart,           // byte offset of the image descriptor
        dataOffset: -1,               // offset of the first LZW sub-block length byte
        dataEnd: -1,                  // offset after the block terminator (or end of file)
        dataTerminated: false,        // the 0-length sub-block that ends the frame was found
        requiredFrame: -1,            // Skia's required frame (-1: frame starts from transparent)
      };
      frames.push(frame);
      gcHasTrans = false; gcTrans = 0; gcRawDisposal = 0; gcDelay = 0; gcSeen = false;

      if (pos >= n) { eof('image descriptor'); break; }
      const fl = bytes[pos++];
      frame.interlaced = (fl & 0x40) !== 0;
      if (fl & 0x80) {
        const len = 3 * (2 << (fl & 7));
        if (pos + len > n) { frame.localPalette = true; frame.palette = new Uint8Array(0); frame._paletteTruncated = true; eof('local colour table'); break; }
        frame.palette = bytes.slice(pos, pos + len);
        frame.localPalette = true;
        pos += len;
      }
      if (pos >= n) { eof('image data'); break; }
      const lw = bytes[pos++];
      frame.lzwMinCodeSize = lw;
      if (lw > 8) {
        fatal = `frame ${frame.index} has an invalid LZW minimum code size of ${lw}`;
        break;
      }
      frame.dataOffset = pos;
      for (;;) {
        if (pos >= n) { frame.dataEnd = n; eof('image data'); break outer; }
        const bs = bytes[pos++];
        if (bs === 0) break;
        pos += bs;
      }
      frame.dataEnd = pos;
      frame.dataTerminated = true;
    } else {
      // Trailer (0x3B), or anything else: both end the GIF in Chromium (and Firefox).
      end = { kind: b === 0x3b ? 'trailer' : 'garbage', offset: blockStart, byte: b };
      break;
    }
  }

  if (frames.length === 0) {
    if (fatal) throw gifError(`The GIF cannot be decoded: its ${fatal}. Chrome cannot display it either.`, 'malformed');
    if (end && end.kind === 'eof') throw gifError('The GIF file is cut off before its first frame.', 'truncated');
    throw gifError('The GIF contains no frames.', 'no-frames');
  }
  if (width === 0 || height === 0) {
    throw gifError(`The GIF has an empty canvas (${width}×${height}); there is nothing to show.`, 'empty-canvas');
  }

  // Warnings about structure.
  const last = frames[frames.length - 1];
  if (fatal) {
    warnings.push(`The GIF's ${fatal}; Chrome stops reading there, so anything after frame ${last.index} is ignored.`);
  } else if (end.kind === 'eof') {
    if (!last.dataTerminated) {
      warnings.push(`File ends early, inside frame ${last.index} (${end.where}).`);
    } else if (end.where === 'between blocks') {
      warnings.push(`File ends without the GIF trailer byte after frame ${last.index} (harmless).`);
    } else {
      warnings.push(`File ends early, after frame ${last.index} (inside ${/^[aeiou]/.test(end.where) ? 'an' : 'a'} ${end.where}).`);
    }
  } else if (end.kind === 'garbage') {
    warnings.push(`Unexpected byte 0x${end.byte.toString(16).padStart(2, '0')} at offset ${end.offset} after frame ${last.index}; treated as the end of the GIF (as Chrome does).`);
  } else if (end.offset + 1 < n) {
    warnings.push(`${n - end.offset - 1} bytes of extra data after the GIF trailer were ignored.`);
  }
  if (width !== screenWidth || height !== screenHeight) {
    warnings.push(`The first frame extends beyond the ${screenWidth}×${screenHeight} logical screen; the canvas is enlarged to ${width}×${height} (as Chrome does).`);
  }

  computeRequiredFrames(frames, width, height);

  const gif = {
    width, height, screenWidth, screenHeight, loopCount, version, backgroundIndex,
    globalPalette, frames, warnings,
  };
  Object.defineProperty(gif, '_bytes', { value: bytes, enumerable: false });
  return gif;
}

// Frame rectangle clipped to the canvas, as Wuffs reports it (x0, y0, x1, y1).
function clippedRect(f, W, H) {
  const x0 = Math.min(f.left, W), y0 = Math.min(f.top, H);
  const x1 = Math.min(f.left + f.width, W), y1 = Math.min(f.top + f.height, H);
  return [x0, y0, x1, y1];
}

function rectEmpty(r) { return !(r[0] < r[2] && r[1] < r[3]); }
function rectEq(a, b) { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]; }
function rectContains(a, b) {
  return !rectEmpty(b) && !rectEmpty(a) && a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];
}

// Port of SkFrameHolder::setAlphaAndRequiredFrame (Skia), which decides whether a frame starts
// from a transparent canvas (independent) or from an earlier frame.
function computeRequiredFrames(frames, W, H) {
  const screen = [0, 0, W, H];
  const onScreen = (f) => { const r = clippedRect(f, W, H); return rectEmpty(r) ? [0, 0, 0, 0] : r; };
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    f.rect = clippedRect(f, W, H);
    if (i === 0) { f.requiredFrame = -1; continue; }
    const reportsAlpha = f.transparentIndex >= 0;
    const frameRect = onScreen(f);
    if (!reportsAlpha && rectEq(frameRect, screen)) { f.requiredFrame = -1; continue; }
    let prev = frames[i - 1];
    let done = false;
    while (prev.dispose === DISPOSE_PREVIOUS) {
      if (prev.index === 0) { f.requiredFrame = -1; done = true; break; }
      prev = frames[prev.index - 1];
    }
    if (done) continue;
    const clearPrev = prev.dispose === DISPOSE_BACKGROUND;
    let prevRect = onScreen(prev);
    if (clearPrev && (rectEq(prevRect, screen) || prev.requiredFrame === -1)) { f.requiredFrame = -1; continue; }
    if (reportsAlpha) { f.requiredFrame = prev.index; continue; }
    while (rectContains(frameRect, prevRect)) {
      if (prev.requiredFrame === -1) { f.requiredFrame = -1; done = true; break; }
      prev = frames[prev.requiredFrame];
      prevRect = onScreen(prev);
    }
    if (done) continue;
    f.requiredFrame = prev.index;
  }
  // The frame Blink actually copies from when decoding in order: the latest earlier frame that
  // is not "restore previous", if that is later than the required frame (Skia then skips the
  // required frame's disposal); otherwise the required frame itself.
  let lastKept = -1;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    f._prior = (f.requiredFrame >= 0 && lastKept > f.requiredFrame) ? lastKept : -1;
    if (f.dispose !== DISPOSE_PREVIOUS) lastKept = i;
  }
}

// ---------------------------------------------------------------------------------------------
// LZW (Wuffs semantics). Writes palette indices in stream order into `out`.

const LZW_OK_FULL = 0;      // produced every pixel of the frame
const LZW_END_CODE = 1;     // end code reached
const LZW_BAD_CODE = 2;     // code larger than the next free table entry
const LZW_OUT_OF_DATA = 3;  // ran out of compressed data

// Table entry k is the string out[entryPos[k] .. entryPos[k] + entryLen[k]). Literal codes point
// into a small table of their own values kept at the end of `out`, so literals and table strings
// take the same path; the clear and end codes have length 0.
const entryPos = new Int32Array(4096);
const entryLen = new Uint16Array(4096);
const LZW_SLACK = 4400; // out needs npix + LZW_SLACK bytes: overshoot, 8-byte copies, literal table
let lzwStatus = 0, lzwAnyOutput = false;
let dvTarget = null, dvView = null;

/**
 * Decode LZW data into `out` (length >= npix + LZW_SLACK); returns the number of indices
 * written, which may exceed npix by up to 4096. Sets lzwStatus and lzwAnyOutput.
 */
function lzwDecode(src, srcLen, lw, out, npix) {
  const clear = 1 << lw, eoi = clear + 1;
  const ePos = entryPos, eLen = entryLen;
  if (out !== dvTarget) { dvTarget = out; dvView = new DataView(out.buffer, out.byteOffset, out.byteLength); }
  const dv = dvView;
  const litBase = out.length - 272;
  for (let c = 0; c < clear; c++) { out[litBase + c] = c; ePos[c] = litBase + c; eLen[c] = 1; }
  eLen[clear] = 0; eLen[eoi] = 0;
  // Wuffs: `save` is the next table slot; it starts at eoi, and the first code after a clear
  // only advances it (the entry written there has length prevLen + 1 = 0, keeping eoi a control
  // code). The code width grows when save reaches 1 << width, up to 12 bits.
  let save = eoi, width = lw + 1, mask = (1 << width) - 1, grow = 1 << width;
  let bits = 0, nbits = 0, p = 0, op = 0, prevPos = 0, prevLen = -1;
  let status = LZW_OUT_OF_DATA;
  const end2 = srcLen - 1;
  for (;;) {
    if (nbits < width) {
      if (p < end2) {
        bits |= (src[p] | (src[p + 1] << 8)) << nbits;
        p += 2; nbits += 16;
      } else if (p < srcLen) {
        bits |= src[p++] << nbits; nbits += 8;
        if (nbits < width) break;
      } else break;
    }
    const code = bits & mask;
    bits >>>= width;
    nbits -= width;
    let len;
    if (code < save) {
      len = eLen[code];
      if (len === 0) {
        if (code === eoi) { status = LZW_END_CODE; break; }
        save = eoi; width = lw + 1; mask = (1 << width) - 1; grow = 1 << width; prevLen = -1; // clear
        continue;
      }
      const from = ePos[code];
      if (len <= 8) {
        // Fixed 8-byte copy (out has slack), so the short strings that dominate dithered
        // images cost no length-dependent branching.
        dv.setUint32(op, dv.getUint32(from, true), true);
        dv.setUint32(op + 4, dv.getUint32(from + 4, true), true);
      } else if (len < 24) { for (let k = 0; k < len; k++) out[op + k] = out[from + k]; }
      else out.copyWithin(op, from, from + len);
    } else if (code === save && code !== eoi) {
      // The code being defined: previous string + its own first index.
      len = prevLen;
      const from = prevPos;
      if (len <= 8) {
        dv.setUint32(op, dv.getUint32(from, true), true);
        dv.setUint32(op + 4, dv.getUint32(from + 4, true), true);
      } else if (len < 24) { for (let k = 0; k < len; k++) out[op + k] = out[from + k]; }
      else out.copyWithin(op, from, from + len);
      out[op + len] = out[from];
      len++;
    } else {
      status = code === eoi ? LZW_END_CODE : LZW_BAD_CODE;
      break;
    }
    if (save < 4096) {
      ePos[save] = prevPos; eLen[save] = prevLen + 1;
      save++;
      if (save >= grow && width < 12) { width++; mask = (mask << 1) | 1; grow <<= 1; }
    }
    prevPos = op; prevLen = len; op += len;
    if (op >= npix) { status = LZW_OK_FULL; break; }
  }
  lzwStatus = status;
  lzwAnyOutput = op > 0;
  return op;
}

/**
 * Run the LZW state machine without producing output (for frames with no pixels, whose data
 * Wuffs still checks). Sets lzwStatus and lzwAnyOutput; never stops for "frame full".
 */
function lzwValidate(src, srcLen, lw) {
  const clear = 1 << lw, eoi = clear + 1;
  let save = eoi, width = lw + 1, mask = (1 << width) - 1, havePrev = false;
  let bits = 0, nbits = 0, p = 0, any = false;
  let status = LZW_OUT_OF_DATA;
  for (;;) {
    while (nbits < width && p < srcLen) { bits |= src[p++] << nbits; nbits += 8; }
    if (nbits < width) break;
    const code = bits & mask;
    bits >>>= width;
    nbits -= width;
    if (code === clear) { save = eoi; width = lw + 1; mask = (1 << width) - 1; havePrev = false; continue; }
    if (code === eoi) { status = LZW_END_CODE; break; }
    if (code > clear && code > save) { status = LZW_BAD_CODE; break; }
    if (code > clear && code === save && !havePrev) { status = LZW_BAD_CODE; break; }
    any = true;
    if (save < 4096) {
      save++;
      if (width < 12) { width += (save >> width) & 1; mask = (1 << width) - 1; }
      havePrev = true;
    }
  }
  lzwStatus = status;
  lzwAnyOutput = any;
}

// Scratch buffers reused between frames (the decoder is synchronous, so this is safe).
let dataScratch = new Uint8Array(1 << 16);
let indexScratch = new Uint8Array(1 << 16);

function gatherFrameData(bytes, frame) {
  const start = frame.dataOffset, end = frame.dataEnd;
  if (start < 0) return 0;
  if (dataScratch.length < end - start) dataScratch = new Uint8Array(Math.max(end - start, dataScratch.length * 2));
  const out = dataScratch;
  let p = start, q = 0;
  while (p < end) {
    const bs = bytes[p++];
    if (bs === 0) break;
    const stop = Math.min(p + bs, end);
    if (stop - p > 32) out.set(bytes.subarray(p, stop), q);
    else for (let k = p; k < stop; k++) out[q + k - p] = bytes[k];
    q += stop - p;
    p = stop;
  }
  return q;
}

/**
 * Run LZW for one frame. Returns { indices (stream order, length >= npix), decoded, ok, problem }.
 * `ok` follows Wuffs/Chromium: the frame decodes successfully.
 */
function decodeFrameData(bytes, frame) {
  const npix = frame.width * frame.height;
  const need = npix + LZW_SLACK;
  if (indexScratch.length < need) indexScratch = new Uint8Array(Math.max(need, Math.min(indexScratch.length * 2, need * 2)));
  const out = indexScratch;
  const res = { indices: out, decoded: 0, ok: false, problem: null, maxIndex: -1 };
  const lw = frame.lzwMinCodeSize;
  if (frame._paletteTruncated || lw < 0) { res.problem = 'the file ends before its image data'; return res; }
  if (lw > 8) { res.problem = `its LZW minimum code size is ${lw} (the maximum is 8)`; return res; }
  const len = gatherFrameData(bytes, frame);
  let op;
  if (npix === 0) {
    // Empty frame: no pixels, but Wuffs still validates the LZW stream.
    lzwValidate(dataScratch, len, lw);
    res.decoded = 0;
    if (lzwStatus === LZW_BAD_CODE) {
      // Accepted only when the (empty) frame counts as finished: Wuffs requires its row cursor to
      // be past the frame and no interlace pass pending.
      const finished = frame.interlaced ? (frame.width === 0 && frame.height > 0 && lzwAnyOutput)
        : (frame.height === 0 || lzwAnyOutput);
      if (!finished) { res.problem = 'its LZW data contains an invalid code'; return res; }
    }
    if (!frame.dataTerminated) { res.problem = 'the file ends inside its image data'; return res; }
    res.ok = true;
    return res;
  }
  op = lzwDecode(dataScratch, len, lw, out, npix);
  // Highest index used, only needed when the colour table is smaller than the code space.
  const palN = (frame.palette.length / 3) | 0;
  if (palN > 0 && palN < (1 << lw)) {
    let m = -1;
    for (let i = 0, n = op < npix ? op : npix; i < n; i++) if (out[i] > m) m = out[i];
    res.maxIndex = m;
  }
  res.decoded = op < npix ? op : npix;
  if (op >= npix) {
    if (!frame.dataTerminated) { res.problem = 'the file ends inside its image data (after all of its pixels)'; return res; }
    res.ok = true;
    return res;
  }
  const pct = Math.floor((100 * op) / npix);
  if (lzwStatus === LZW_BAD_CODE) res.problem = `its LZW data contains an invalid code after ${op} of ${npix} pixels (${pct}%)`;
  else if (lzwStatus === LZW_END_CODE) res.problem = `its LZW data ends (end code) after ${op} of ${npix} pixels (${pct}%)`;
  else if (!frame.dataTerminated) res.problem = `the file ends inside its image data after ${op} of ${npix} pixels (${pct}%)`;
  else res.problem = `its image data runs out after ${op} of ${npix} pixels (${pct}%)`;
  return res;
}

// Row order of an interlaced frame: stream row -> frame row.
function interlaceRows(h) {
  const rows = new Int32Array(h);
  let s = 0;
  for (let y = 0; y < h; y += 8) rows[s++] = y;
  for (let y = 4; y < h; y += 8) rows[s++] = y;
  for (let y = 2; y < h; y += 4) rows[s++] = y;
  for (let y = 1; y < h; y += 2) rows[s++] = y;
  return rows;
}

function buildPalette32(frame) {
  const pal = new Uint32Array(256).fill(OPAQUE_BLACK);
  const p = frame.palette;
  const count = Math.min(256, (p.length / 3) | 0);
  for (let i = 0, o = 0; i < count; i++, o += 3) {
    pal[i] = LITTLE_ENDIAN
      ? ((0xff000000 | (p[o + 2] << 16) | (p[o + 1] << 8) | p[o]) >>> 0)
      : ((((p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8)) | 0xff) >>> 0);
  }
  if (frame.transparentIndex >= 0) pal[frame.transparentIndex] = 0;
  return pal;
}

/**
 * Draw `decoded` stream-order indices of `frame` onto the canvas (Uint32 view).
 * overwrite=true: every pixel is written (transparent index writes 0) — Chromium's mode for
 * frames that start from a cleared canvas. Otherwise the transparent index leaves the canvas.
 */
function drawIndices(dst32, W, H, frame, idx, decoded, pal, overwrite, replicate) {
  const fw = frame.width, fh = frame.height;
  if (fw === 0 || fh === 0 || decoded <= 0) return;
  const x0 = frame.left, y0 = frame.top;
  const xEnd = Math.min(x0 + fw, W);
  const visW = xEnd - x0; // may be <= 0 when the frame starts right of the canvas
  const trans = overwrite ? -1 : frame.transparentIndex;
  const fullRows = (decoded / fw) | 0;
  const rem = decoded - fullRows * fw;
  const rowCount = fullRows + (rem > 0 ? 1 : 0);
  const rows = frame.interlaced ? interlaceRows(fh) : null;
  let passEnd1 = 0, passEnd2 = 0, passEnd3 = 0;
  if (replicate && rows) {
    passEnd1 = ((fh + 7) >> 3);
    passEnd2 = passEnd1 + ((fh + 3) >> 3);
    passEnd3 = passEnd2 + ((fh + 1) >> 2);
  }
  for (let s = 0; s < rowCount; s++) {
    const fy = rows ? rows[s] : s;
    const cy = y0 + fy;
    if (cy >= H || visW <= 0) continue;
    const cnt = s < fullRows ? visW : Math.min(visW, rem);
    let si = s * fw;
    let di = cy * W + x0;
    const dend = di + cnt;
    if (trans < 0) {
      while (di < dend) dst32[di++] = pal[idx[si++]];
    } else {
      while (di < dend) {
        const v = idx[si++];
        if (v !== trans) dst32[di] = pal[v];
        di++;
      }
    }
    // Wuffs replicates the rows of the first three interlace passes of the first frame (when it
    // has no transparency) so a partly received image looks complete. Later passes overwrite
    // the copies, so this only shows when the frame is cut short.
    if (replicate && rows && s < fullRows && s < passEnd3) {
      const count = s < passEnd1 ? 8 : s < passEnd2 ? 4 : 2;
      const yStop = Math.min(fy + count, fh);
      const srcRow = cy * W + x0;
      for (let ry = fy + 1; ry < yStop; ry++) {
        const ty = y0 + ry;
        if (ty >= H) break;
        dst32.copyWithin(ty * W + x0, srcRow, srcRow + visW);
      }
    }
  }
}

function zeroRect(canvas, W, r) {
  const [x0, y0, x1, y1] = r;
  if (!(x0 < x1 && y0 < y1)) return;
  const rowBytes = (x1 - x0) * 4;
  for (let y = y0; y < y1; y++) {
    const o = (y * W + x0) * 4;
    canvas.fill(0, o, o + rowBytes);
  }
}

function playedDelay(raw) { return raw <= 1 ? 10 : raw; }

// Core iterator shared by decodeGif and decodeFrames. Every yielded `rgba` is a new array that
// belongs to the caller: canvases that later frames start from are kept privately, so changing a
// yielded frame never affects the frames after it.
function* compositeFrames(gif) {
  const bytes = gif._bytes;
  const W = gif.width, H = gif.height;
  const frames = gif.frames;
  const total = W * H;
  if (total * 4 > 0x7fffffff) throw gifError(`The GIF canvas is too large to decode (${W}×${H}).`, 'too-large');
  // The last frame that may start from each frame's canvas (-1: none).
  const lastUse = new Int32Array(frames.length).fill(-1);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.requiredFrame >= 0) lastUse[f.requiredFrame] = i;
    if (f._prior >= 0) lastUse[f._prior] = i;
  }
  const kept = new Map();                      // frame index -> private canvas still needed
  const shown = new Uint8Array(frames.length); // Chromium would return this frame
  const ownOk = new Uint8Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const warnings = [];
    const req = f.requiredFrame;
    let src = -1, overwrite = true, dependsOnBroken = -1, clearRect = null;
    if (req >= 0) {
      overwrite = false;
      const prior = f._prior;
      if (prior >= 0 && ownOk[prior] && shown[prior]) src = prior;
      else {
        src = req;
        if (frames[req].dispose === DISPOSE_BACKGROUND) clearRect = frames[req].rect;
        if (!shown[req]) dependsOnBroken = req;
      }
    }
    let canvas;
    if (src < 0) canvas = new Uint8ClampedArray(total * 4);
    else if (lastUse[src] === i) { canvas = kept.get(src); kept.delete(src); } // last use: draw in place
    else canvas = kept.get(src).slice();
    if (clearRect) zeroRect(canvas, W, clearRect);
    const dst32 = new Uint32Array(canvas.buffer, canvas.byteOffset, total);
    const res = decodeFrameData(bytes, f);
    const pal = buildPalette32(f);
    drawIndices(dst32, W, H, f, res.indices, res.decoded, pal, overwrite,
      i === 0 && f.interlaced && f.transparentIndex < 0 && res.decoded < f.width * f.height);
    ownOk[i] = res.ok ? 1 : 0;
    shown[i] = res.ok && dependsOnBroken < 0 ? 1 : 0;
    if (!res.ok) {
      warnings.push(`Frame ${i} is damaged: ${res.problem}. Chrome does not show this frame; the part that could be decoded is returned.`);
      if (!gif._firstProblem) Object.defineProperty(gif, '_firstProblem', { value: `frame ${i}: ${res.problem}`, configurable: true });
    }
    if (dependsOnBroken >= 0) warnings.push(`Frame ${i} is drawn on top of damaged frame ${dependsOnBroken}; Chrome does not show it.`);
    if (f.palette.length === 0 && f.width * f.height > 0) warnings.push(`Frame ${i} has no colour table; its pixels are drawn black (as Chrome does).`);
    else if (res.maxIndex >= f.palette.length / 3 && res.maxIndex !== f.transparentIndex) warnings.push(`Frame ${i} uses colour index ${res.maxIndex} but its colour table has only ${f.palette.length / 3} entries; such pixels are drawn black (as Chrome does).`);
    // Release kept canvases no later frame starts from (a frame that could only have been
    // reached through a fallback path may leave one behind).
    for (const j of kept.keys()) if (lastUse[j] <= i) kept.delete(j);
    let rgba = canvas;
    if (lastUse[i] > i) { kept.set(i, canvas); rgba = canvas.slice(); }
    yield {
      index: i,
      rgba,
      delay: playedDelay(f.delay),
      rawDelay: f.delay,
      complete: shown[i] === 1,
      decodedPixels: res.decoded,
      frame: f,
      warnings,
    };
  }
}

function resolveGif(input) {
  if (input && typeof input === 'object' && Array.isArray(input.frames) && input._bytes) return input;
  return parseGif(input);
}

/**
 * Decode every frame, composited exactly as Chrome shows it.
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView|object} input GIF bytes (or a parseGif result)
 * @param {{onFrame?: (f:{index:number,rgba:Uint8ClampedArray,delay:number,rawDelay:number,complete:boolean,frameCount:number}) => void}} [options]
 * @returns {{width:number,height:number,loopCount:number|null,frames:Uint8ClampedArray[],delays:number[],
 *   rawDelays:number[],complete:boolean[],warnings:string[],frameInfo:object[]}}
 */
export function decodeGif(input, { onFrame } = {}) {
  const gif = resolveGif(input);
  const frames = [], delays = [], rawDelays = [], complete = [];
  const warnings = gif.warnings.slice();
  let anyPixels = false;
  for (const fr of compositeFrames(gif)) {
    frames.push(fr.rgba);
    delays.push(fr.delay);
    rawDelays.push(fr.rawDelay);
    complete.push(fr.complete);
    for (const w of fr.warnings) warnings.push(w);
    if (fr.decodedPixels > 0) anyPixels = true;
    if (onFrame) onFrame({ index: fr.index, rgba: fr.rgba, delay: fr.delay, rawDelay: fr.rawDelay, complete: fr.complete, frameCount: gif.frames.length });
  }
  if (!anyPixels && !gif.frames.some(f => f.width * f.height === 0 && f.dataTerminated)) {
    throw gifError('The GIF has no decodable frame (' + (gif._firstProblem || 'no image data could be decoded') + '). Chrome cannot display it either.', 'no-image-data');
  }
  return { width: gif.width, height: gif.height, loopCount: gif.loopCount, frames, delays, rawDelays, complete, warnings, frameInfo: gif.frames };
}

/**
 * Generator: yields composited frames one at a time, so long GIFs can be streamed without
 * holding every frame. Each yielded `rgba` is a new Uint8ClampedArray (width*height*4) owned by
 * the caller (modify or transfer it freely; it is never reused). The generator itself keeps
 * only the canvases later frames start from (usually one).
 * Yields { index, rgba, delay, rawDelay, complete, frame, warnings }.
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView|object} input GIF bytes or a parseGif result
 */
export function* decodeFrames(input) {
  const gif = resolveGif(input);
  for (const fr of compositeFrames(gif)) {
    yield { index: fr.index, rgba: fr.rgba, delay: fr.delay, rawDelay: fr.rawDelay, complete: fr.complete, frame: fr.frame, warnings: fr.warnings };
  }
}

/**
 * The raw palette indices of one frame (its own width×height, rows in display order, not
 * composited). Pixels that could not be decoded are 0; `complete` says whether all decoded.
 * @returns {{indices:Uint8Array,width:number,height:number,decodedPixels:number,complete:boolean,frame:object}}
 */
export function decodeFrameIndices(input, index) {
  const gif = resolveGif(input);
  const f = gif.frames[index];
  if (!f) throw new RangeError(`Frame ${index} does not exist (the GIF has ${gif.frames.length} frames).`);
  const res = decodeFrameData(gif._bytes, f);
  const npix = f.width * f.height;
  const indices = new Uint8Array(npix);
  if (!f.interlaced) {
    indices.set(res.indices.subarray(0, res.decoded));
  } else {
    const rows = interlaceRows(f.height);
    for (let s = 0, done = 0; done < res.decoded; s++) {
      const cnt = Math.min(f.width, res.decoded - done);
      indices.set(res.indices.subarray(done, done + cnt), rows[s] * f.width);
      done += cnt;
    }
  }
  return { indices, width: f.width, height: f.height, decodedPixels: res.decoded, complete: res.ok, frame: f };
}
