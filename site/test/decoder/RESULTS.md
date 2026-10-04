# gifdecode.js conformance results

Decoder: `site/assets/gifdecode.js` (ES module, no dependencies; works in a page, a module worker and Node).
Reference: Chromium's WebCodecs `ImageDecoder` (Playwright's Chromium, M141: Skia SkWuffsCodec / Wuffs v0.3 GIF + LZW, composited by Blink), with each frame read back through canvas `getImageData` in the same page.

## API

```js
parseGif(bytes) -> { width, height, loopCount /* null = no loop block, 0 = forever */, frames: [{ index, left, top,
  width, height, delay /* raw cs */, disposal /* raw 0-7 */, dispose /* 0|2|3, as applied */, transparentIndex /* -1 */,
  interlaced, palette /* Uint8Array RGB, local or global */, localPalette, lzwMinCodeSize, requiredFrame, ... }], warnings }
decodeGif(bytes, { onFrame } = {}) -> { width, height, loopCount, frames: Uint8ClampedArray[] /* RGBA, transparent = 0,0,0,0 */,
  delays /* as Chrome plays: 0 or 1 cs -> 10 */, rawDelays, complete: boolean[], warnings, frameInfo }
decodeFrames(bytesOrParsed)          // generator: { index, rgba, delay, rawDelay, complete, frame, warnings }
decodeFrameIndices(bytesOrParsed, i) // raw palette indices of one frame (not composited)
```

`bytes` can be a Uint8Array, ArrayBuffer or any ArrayBufferView. Every RGBA array handed out (in `frames`, to `onFrame`, or from the generator) is new and belongs to the caller, so you can change or transfer it straight away. The decoder keeps private copies of the canvases later frames are built on (usually just one). Non-GIF input (it recognises PNG, JPEG, WebP, MP4, WebM, BMP, TIFF and HTML) and GIFs with no decodable frame throw an `Error` with a plain-English message. `e.name` is `'GifDecodeError'` and `e.code` is one of `empty`, `truncated`, `not-gif`, `malformed`, `no-frames`, `empty-canvas`, `too-large` or `no-image-data`.

## Results (`node compare.mjs ...`; logs and per-file JSON lines in `results/`)

| set | files | result |
|---|---|---|
| `gif/corpus/gifs` | 281 | 281 pass |
| Wikimedia: Newtons_cradle (36 f), Rotating_earth (44 f), Sorting_quicksort (70 f, real file in `wikimedia/`) | 3 | 3 pass |
| `gif/Sorting_quicksort_anim.gif` (it is a Wikimedia HTML error page, not a GIF) | 1 | both reject |
| `gif/fuzz2out/inputs/*.gif` (all) | 2022 | 2022 pass |
| `gif/fuzz2out/gifs/*.gif` (all) | 5000 | 5000 pass |
| `edge/`: hand-made edge cases (`make_edge.py`, byte-exact writer `gifwriter.py`) | 251 | 146 pass + 105 pass-with-damaged-frames |
| `random/`: 150 valid + 80 damaged random GIFs | 230 | 166 pass + 64 pass-with-damaged-frames |
| `trunc/`: 3 GIFs cut at every byte offset | 553 | 298 pass + 255 pass-with-damaged-frames |
| `probe/`, `probe2/`: discovery probes | 27 | 5 pass + 22 pass-with-damaged-frames |

**Failures: none.** "pass-with-damaged-frames" means that Chrome rejects some frames, and that we flag exactly those frames `complete[i] = false`. Their partial pixels still match Chrome's `completeFramesOnly: false` output, compared on the raw `VideoFrame.copyTo` bytes. The comparison checks frame count, size, loop count, every delay, alpha everywhere, and RGB wherever alpha is non-zero. `selftest.mjs` checks that the generator matches `decodeGif`, that caller-owned frames are never reused, and the error messages. `worker_check.mjs` checks that the decoder works in a module worker.

## Chromium behaviours (all reproduced)

- The canvas starts fully transparent, and the background colour index is ignored.
- The first frame enlarges the canvas if it does not fit in the logical screen. Later frames are clipped.
- A 0×0 screen works when the first frame is not empty. Otherwise the file is rejected.
- Disposal 2 clears the frame rectangle (clipped) to transparent. Disposals 3 and 4 restore the previous canvas. Disposals 0, 1, 5, 6 and 7 keep it.
- Disposal 3 on the first frame restores to a transparent canvas. Consecutive disposal-3 frames all restore to the last kept frame.
- The transparent index is transparent even when it lies beyond the palette.
- Indices beyond the palette, and frames with no colour table at all, are drawn opaque black.
- Interlaced frames decode normally. The first frame's rows are replicated as in Wuffs, which is only visible when that frame is cut short.
- LZW minimum code sizes 0–8 are accepted, and 0 and 1 work. A size above 8 makes that frame undecodable, and parsing stops after it.
- The following LZW streams are all accepted: no initial clear code, clears in the middle of a frame, a full table with no clear, no end code, data after the end code, too much pixel data, and invalid codes after the frame is complete.
- An invalid code, an early end code or data that runs out before the frame is complete makes Chrome reject that frame. Frames composited on top of it are rejected too. Partial pixels are available with `completeFramesOnly: false`.
- A file cut off inside a frame: that frame is rejected and the earlier frames are kept. A single-frame file cut off this way is rejected entirely.
- `ImageDecoder` reports the raw delay (0 stays 0), but Chrome plays 0 and 1 cs as 10 cs.
- With several Graphic Control Extensions before one image, the last one wins entirely.
- A Graphic Control Extension whose block size is not 4, or that has a non-zero terminator, stops parsing. On the first frame this means the file is rejected.
- Comment, plain-text and unknown application extensions are skipped.
- The NETSCAPE2.0 / ANIMEXTS1.0 loop sub-block must have size 3 and id 1. The last one wins, even after frames. Without one, repetitionCount is 0 for animations and Infinity for single frames.
- Any unexpected byte between blocks ends the file, as does a missing trailer. Headers other than GIF87a and GIF89a are rejected.
- Quirk: a partial frame can be tagged opaque (BGRX) while holding transparent pixels, so drawing it on a reused canvas shows stale pixels. We return the raw bytes (transparent where not decoded).

## Choices where Chromium does not show anything

- **Damaged frames:** Chrome's ImageDecoder rejects them. We return what could be decoded, composited the way Chrome composites partial frames, and set `complete[i] = false` with a warning. Frames built on a damaged frame are returned the same way.
- **Files where nothing can be decoded:** we throw ("The GIF has no decodable frame (...). Chrome cannot display it either.").

## Speed (`bench.mjs`; output megapixels per second, median of 7; 4-vCPU Xeon 2.8 GHz VM)

| file | MP | Node | Chromium page, ours | ImageDecoder decode | ImageDecoder + copyTo RGBA |
|---|---|---|---|---|---|
| xiph_harbour_cif_0__ffbayer (4.8 MB) | 4.6 | 74 | 64 | 103 | 67 |
| xiph_husky_cif_1__ffpal | 4.6 | 82 | 69 | 118 | 66 |
| xiph_bus_cif_0__ffpal | 4.6 | 92 | 73 | 116 | 72 |
| screen_code_dark__ffbayer | 15.4 | 355 | 215 | 240 | 121 |
| screen_webpage__ffbayer | 14.4 | 235 | 160 | 303 | 152 |
| Newtons_cradle | 6.2 | 504 | 285 | 536 | 221 |
| Rotating_earth (large) | 7.0 | 281 | 177 | 332 | 168 |
| Sorting_quicksort | 4.2 | 319 | 271 | 437 | 163 |
| all 10 benchmark files | 79.3 | 208 | 151 | 227 | 122 |

Ours runs at about 0.65× Chrome's decode-only speed. It is a little faster than Chrome once Chrome's frames are copied out as RGBA, which is the form `decodeGif` returns. Optimisation took the overall figures from 158 to 208 MP/s in Node and from 124 to 151 MP/s in the page (`results/bench_before.log`). It made two changes. First, literal codes and table strings now share one table, with fixed 8-byte copies for short strings. Second, the highest colour index is now computed only when the palette is smaller than the code space. Most of the remaining time on dithered video GIFs (1.3 pixels per code) goes on the LZW loop.

## Files

- `compare.mjs`, `lib/harness-page.js`, `lib/chromium.mjs`: the Playwright comparison harness. Usage: `node compare.mjs [--sample N] [--name X] files|dirs`.
- `make_edge.py` and `gifwriter.py`: generate `edge/`, `random/` and `trunc/`.
- `bench.mjs`, `selftest.mjs`, `worker_check.mjs`: speed, API and worker checks.
- `probe.mjs` (ASCII dump of what Chrome returns), `probe1.py`, `probe_order.mjs`, `probe_copyto.mjs`: experiments used to discover the behaviours above.
