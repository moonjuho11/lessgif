// JavaScript wrapper over the WebAssembly build of lessgif (see wasm/src/lib.rs for the C ABI).
// Works in a page or a module worker. Single-threaded; run it in a worker to keep a page responsive.
//
//   const gz = await loadLessGif();                       // fetches ./lessgif.wasm next to this file
//   const { gif } = gz.encode({ w, h, n, getFrame: (i) => rgbaBytes[i], delays, quality: 70 });

export async function loadLessGif(url = new URL('./lessgif.wasm', import.meta.url)) {
  let instance;
  try {
    ({ instance } = await WebAssembly.instantiateStreaming(fetch(url), {}));
  } catch (e) {
    // servers that don't send application/wasm make instantiateStreaming fail; compile from bytes
    const res = await fetch(url);
    if (!res.ok) throw new Error(`couldn't load ${url} (${res.status})`);
    ({ instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {}));
  }
  return new LessGif(instance.exports);
}

export class LessGif {
  constructor(exports) {
    this.x = exports;
  }

  // Memory can grow during any call, so views on it are made fresh each time.
  bytes() {
    return new Uint8Array(this.x.memory.buffer);
  }
  str(ptr, len) {
    return new TextDecoder().decode(this.bytes().slice(ptr, ptr + len));
  }
  check(s, r, what) {
    if (r < 0) throw new Error(`${what}: ${this.str(this.x.gz_err_ptr(s), this.x.gz_err_len(s))}`);
    return r;
  }

  // Encodes n frames of w*h RGBA. getFrame(i) returns frame i as a Uint8Array or
  // Uint8ClampedArray; it is called twice per frame (palette pass, then encode pass), so frames
  // can be produced on demand. delays[i] is in centiseconds (see delaysForFps).
  // Settings: quality 0-100 (like the CLI's --quality), or lambda and tbias directly.
  // loop: repeats after the first play, 0 for forever (the default), -1 to play once.
  // onProgress(done, total) is called after each of the 2n frame steps.
  // Returns { gif: Uint8Array, colors, framesWritten, ms }.
  encode({ w, h, n, getFrame, delays, quality, lambda = 60, tbias = 150, colors = 255, dither = 0.75, loop = 0, onProgress }) {
    const x = this.x;
    const t0 = performance.now();
    const s = quality === undefined ? x.gz_new(colors, lambda, tbias, dither, 40, 0, 0) : x.gz_new_quality(quality, colors, dither);
    const fsz = w * h * 4;
    const buf = x.gz_alloc(fsz);
    try {
      x.gz_set_loop(s, loop);
      for (let i = 0; i < n; i++) {
        this.bytes().set(getFrame(i), buf);
        this.check(s, x.gz_pal_add(s, buf, w, h), 'palette');
        onProgress?.(i + 1, 2 * n);
      }
      const ncolors = this.check(s, x.gz_pal_build(s), 'palette');
      this.check(s, x.gz_enc_new(s, w, h), 'encoder');
      for (let i = 0; i < n; i++) {
        this.bytes().set(getFrame(i), buf);
        this.check(s, x.gz_enc_push(s, buf, delays[i]), `frame ${i}`);
        onProgress?.(n + i + 1, 2 * n);
      }
      const len = this.check(s, x.gz_enc_finish(s), 'finish');
      const ptr = x.gz_out_ptr(s);
      const gif = this.bytes().slice(ptr, ptr + len);
      return { gif, colors: ncolors, framesWritten: x.gz_frames_written(s), ms: performance.now() - t0 };
    } catch (e) {
      if (e instanceof WebAssembly.RuntimeError) {
        throw new Error(`lessgif crashed (${e.message}): ${this.str(x.gz_panic_ptr(), x.gz_panic_len())}`);
      }
      throw e;
    } finally {
      try {
        x.gz_free(buf, fsz);
        x.gz_destroy(s);
      } catch {
        // after a crash the instance is unusable anyway; load a new one
      }
    }
  }

  // The CLI's --max-size search: proposes (quality, scale) attempts until the best one that
  // fits targetBytes is found. scale < 1 means "shrink the frames to this fraction first".
  //
  //   const search = gz.sizeSearch(500 * 1024);
  //   for (let a; (a = search.next()); ) search.report(encodeAt(a.quality, a.scale).length);
  //   const best = search.best();   // { quality, scale } or null if nothing fit
  //   search.close();
  sizeSearch(targetBytes) {
    const x = this.x;
    const q = x.gz_search_new(targetBytes);
    const cur = () => ({ quality: x.gz_search_quality(q), scale: x.gz_search_scale(q) });
    return {
      next: () => (x.gz_search_next(q) ? cur() : null),
      report: (bytes) => x.gz_search_report(q, bytes),
      best: () => (x.gz_search_best(q) ? cur() : null),
      close: () => x.gz_search_destroy(q),
    };
  }
}

// GIF delays are whole centiseconds. These are the CLI's: round((i+1)*100/fps) - round(i*100/fps).
export function delaysForFps(n, fps) {
  const cs = (i) => Math.round((i * 100) / fps);
  return Array.from({ length: n }, (_, i) => cs(i + 1) - cs(i));
}
