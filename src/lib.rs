//! lessgif: a GIF encoder that makes dithering, frame-difference transparency and lossy LZW
//! one joint decision per pixel, all targeting the *source* colour.
//!
//! Existing pipelines do these as separate stages (quantize+dither -> diff -> lossy LZW),
//! so each stage adds error on top of the previous stage's error. Here, every pixel picks
//! either "extend the current LZW string" (almost free in bits) or "start a new code with the
//! best colour", where the transparent index is a candidate whose colour is whatever the
//! previous frame shows at that pixel. The error of whatever was picked is diffused
//! (Floyd-Steinberg style) so local average colour is preserved.
//!
//! This crate is I/O free (no threads unless `threads > 1`, no clocks on wasm) so the same
//! core runs natively and in the browser.
//!
//! Encoding takes two passes over the frames: one to build the palette, one to encode.
//!
//! ```
//! use lessgif::{Encoder, PaletteBuilder, Params, params_for_quality};
//!
//! let (w, h) = (64, 48);
//! // ten RGBA frames of a fading grey (alpha below 128 would mean transparent)
//! let frames: Vec<Vec<u8>> = (0..10u8).map(|i| [i * 20, i * 20, i * 20, 255].repeat(w * h)).collect();
//!
//! let p = params_for_quality(70.0, &Params::default());
//! let mut pb = PaletteBuilder::new();
//! for f in &frames {
//!     pb.add(f, w, h);
//! }
//! let mut enc = Encoder::new(Vec::new(), w, h, pb.palette_for(&p), p, pb.has_clear)?;
//! for f in &frames {
//!     enc.push(f, 10)?; // shown for 10 centiseconds
//! }
//! let (gif, stats) = enc.finish()?;
//! assert_eq!(gif.len(), stats.bytes);
//! # Ok::<(), std::io::Error>(())
//! ```

use std::io::Write;

pub type Rgb = [f32; 3];
type Rect = (usize, usize, usize, usize);

/// LZW minimum code size for a palette of `n` colours plus the transparent index, which is
/// always the last index of the table (2^m - 1). Smaller palettes get shorter codes.
pub fn code_size(n: usize) -> u32 {
    let mut m = 2;
    while (1usize << m) - 1 < n {
        m += 1;
    }
    m
}

#[derive(Clone, Debug)]
pub struct Params {
    pub colors: usize,
    pub lambda: f32,       // extra squared error tolerated to extend an LZW string
    pub tbias: f32,        // squared error forgiven when keeping the previous frame's pixel
    pub dither: f32,       // error diffusion strength 0..1
    pub errclamp: f32,     // clamp on accumulated diffused error per channel
    pub local: bool,       // per-frame palettes instead of one global palette
    pub threads: usize,    // horizontal bands per frame, encoded in parallel
    pub band_bytes: usize, // min expected output bytes per band; 0 = always use all threads
    pub gate: f32,         // temporal denoise: source change (weighted sq. error) below which a pixel is left as is
    /// Edge-aware dithering: at pixels whose luma differs from a neighbour by more than
    /// `edge_lo`, dithering fades out, reaching zero at `edge_hi` (0 = off). Error diffusion
    /// across sharp edges (text, UI) only scatters noise next to them.
    pub edge_lo: f32,
    pub edge_hi: f32,
    /// No dithering in flat areas whose colour is exactly in the palette.
    pub flat_exact: bool,
    /// ... and also at any pixel whose colour is exactly in the palette, flat or not.
    pub flat_exact_any: bool,
    /// A palette colour identical to what's already on screen counts as "keep" (gets `tbias`).
    pub canvas_bonus: bool,
    /// Also encode each changed area without transparency and keep the smaller version.
    pub try_opaque: bool,
    /// Palette may shrink while its average quantization error grows by at most
    /// `palette_tol * lambda` (0 = always use `colors`).
    pub palette_tol: f32,
    /// Where a pixel isn't dithered (flat, exact palette colour), `tbias` and `lambda` are
    /// scaled by this: no error diffusion will correct a stale or off colour there later.
    pub flat_tight: f32,
    /// Code each frame with the smallest LZW alphabet that holds the palette entries it uses.
    pub compact: bool,
    /// Near-lossless: give a frame its own exact palette when the shared one can't show it.
    pub local_auto: bool,
    /// Texture masking: `lambda` and `tbias` follow the source's local contrast, so errors go
    /// where texture hides them instead of into smooth areas (see `texture_map`).
    pub mask: bool,
    /// The loop count written in the NETSCAPE2.0 block: `Some(0)` repeats forever, `Some(n)`
    /// stores n, and `None` writes no block, so browsers play the animation once.
    pub loop_count: Option<u16>,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            colors: 255,
            lambda: 60.0,
            tbias: 150.0,
            dither: 0.75,
            errclamp: 40.0,
            local: false,
            threads: 1,
            band_bytes: 16384,
            gate: 0.0,
            edge_lo: 0.0,
            edge_hi: 0.0,
            flat_exact: true,
            flat_exact_any: false,
            canvas_bonus: false,
            try_opaque: true,
            palette_tol: 0.1,
            flat_tight: 0.25,
            compact: true,
            local_auto: true,
            mask: true,
            loop_count: Some(0),
        }
    }
}

/// Per-pixel dithering strength (0..1).
///
/// Flat areas in a colour the palette has exactly (UI backgrounds, text, cartoons, a GIF being
/// re-compressed) get none: their pixels are already exact, and diffused error from a nearby
/// lossy-LZW choice would only turn them into noise that costs bytes. With `edge_hi > 0`,
/// dithering also fades out across sharp edges (see `Params::edge_lo`).
fn dither_map(src: &[Rgb], w: usize, h: usize, p: &Params, in_pal: &dyn Fn(&Rgb) -> bool) -> Option<Vec<f32>> {
    if !p.flat_exact && p.edge_hi <= 0.0 {
        return None;
    }
    let mut m = vec![1f32; w * h];
    if p.edge_hi > 0.0 {
        let y: Vec<f32> = src.iter().map(|p| 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]).collect();
        for r in 0..h {
            for c in 0..w {
                let i = r * w + c;
                let mut g = 0f32;
                if c > 0 {
                    g = g.max((y[i] - y[i - 1]).abs());
                }
                if c + 1 < w {
                    g = g.max((y[i] - y[i + 1]).abs());
                }
                if r > 0 {
                    g = g.max((y[i] - y[i - w]).abs());
                }
                if r + 1 < h {
                    g = g.max((y[i] - y[i + w]).abs());
                }
                m[i] = ((p.edge_hi - g) / (p.edge_hi - p.edge_lo).max(1e-3)).clamp(0.0, 1.0);
            }
        }
    }
    if p.flat_exact {
        for r in 0..h {
            for c in 0..w {
                let i = r * w + c;
                let v = src[i];
                let mut flat = true;
                'n: for dr in r.saturating_sub(1)..(r + 2).min(h) {
                    for dc in c.saturating_sub(1)..(c + 2).min(w) {
                        if src[dr * w + dc] != v {
                            flat = false;
                            break 'n;
                        }
                    }
                }
                if (flat || p.flat_exact_any) && in_pal(&v) {
                    m[i] = 0.0;
                }
            }
        }
    }
    Some(m)
}

/// Per-pixel (lambda, tbias) multipliers from the source's local luma variance `v` (5x5 window).
///
/// SSIM's structure term (which SSIMULACRA2 weighs most at full resolution) rates noise of
/// variance `e` in a window at about `e / (2v + C)`: noise in a smooth area (a hazy sky, skin)
/// costs far more than the same noise in texture. So the error an LZW extension may add scales
/// with `2v + C` (C = 88, about SSIMULACRA2's constant in sRGB levels^2), relative to a window
/// with a standard deviation of 6 levels: `lambda * (2v + 88 b) / 160`, within [0.2, 8], where
/// `b` follows the area's brightness (see `brightness_weight`).
/// A kept stale pixel in a smooth area mixes two frames' dither noise, so `tbias` follows the
/// square of that factor there, but never grows: kept texture that has moved would ghost.
/// Only basic arithmetic, so native and WebAssembly builds give identical output.
fn texture_map(src: &[Rgb], w: usize, h: usize) -> Vec<[f32; 2]> {
    const R: usize = 2;
    let y: Vec<f64> = src.iter().map(|c| (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) as f64).collect();
    // window sums of y and y^2: along rows, then along columns (prefix sums, exact in f64)
    let mut hs = vec![[0f64; 2]; w * h];
    let mut pre = vec![[0f64; 2]; w.max(h) + 1];
    for r in 0..h {
        for x in 0..w {
            let v = y[r * w + x];
            pre[x + 1] = [pre[x][0] + v, pre[x][1] + v * v];
        }
        for x in 0..w {
            let (a, b) = (x.saturating_sub(R), (x + R + 1).min(w));
            hs[r * w + x] = [pre[b][0] - pre[a][0], pre[b][1] - pre[a][1]];
        }
    }
    let mut out = vec![[1f32; 2]; w * h];
    for x in 0..w {
        let nc = ((x + R + 1).min(w) - x.saturating_sub(R)) as f64;
        for r in 0..h {
            let v = hs[r * w + x];
            pre[r + 1] = [pre[r][0] + v[0], pre[r][1] + v[1]];
        }
        for r in 0..h {
            let (a, b) = (r.saturating_sub(R), (r + R + 1).min(h));
            let n = nc * (b - a) as f64;
            let (s1, s2) = (pre[b][0] - pre[a][0], pre[b][1] - pre[a][1]);
            let var = (s2 / n - (s1 / n) * (s1 / n)).max(0.0);
            let f = ((2.0 * var + 88.0 * brightness_weight(s1 / n)) / 160.0) as f32;
            out[r * w + x] = [f.clamp(0.2, 8.0), (f * f).clamp(0.05, 1.0)];
        }
    }
    out
}

/// How much more error than at mid-grey (level 115) a smooth area of mean luma `m` hides.
/// SSIMULACRA2 compares brightness in XYB, about the cube root of linear light: one sRGB level
/// there weighs ~0.93 around level 50 but ~0.76 at white, so the same noise costs ~1.3x less in
/// a bright sky. This is (s(115) / s(m))^2 for that slope s, piecewise linear; below level 50
/// it stays at its minimum (sRGB's linear toe makes the true curve erratic there).
fn brightness_weight(m: f64) -> f64 {
    if m < 50.0 {
        0.85 + 0.01 * m / 50.0
    } else if m < 115.0 {
        0.86 + 0.14 * (m - 50.0) / 65.0
    } else if m < 180.0 {
        1.0 + 0.16 * (m - 115.0) / 65.0
    } else {
        1.16 + 0.15 * (m - 180.0) / 75.0
    }
}

/// Set of palette colours, for exact-membership tests (2^24-bit bitmap).
fn colour_set(pal: &[Rgb]) -> Vec<u64> {
    let mut bits = vec![0u64; 1 << 18];
    for c in pal {
        let k = (c[0] as usize) << 16 | (c[1] as usize) << 8 | c[2] as usize;
        bits[k >> 6] |= 1 << (k & 63);
    }
    bits
}

#[inline]
fn dist(a: &Rgb, b: &Rgb) -> f32 {
    let dr = a[0] - b[0];
    let dg = a[1] - b[1];
    let db = a[2] - b[2];
    // Brightness difference, weighted like the luminance channel of the XYB eye model that
    // SSIMULACRA2 scores in, plus the two colour differences at lower weight (blue-yellow a
    // little more, since its blotches show at coarse scales). A grey error of d levels costs d^2.
    let dy = 0.265 * dr + 0.657 * dg + 0.078 * db;
    let (dcb, dcr) = (db - dy, dr - dy);
    dy * dy + 0.308 * dcb * dcb + 0.301 * dcr * dcr
}

/// Share of the colour (as opposed to brightness) part of the dithering error that is diffused.
const CHROMA_DIFFUSION: f32 = 0.85;

/// Brightness as `dist` weighs it: palettes are sorted by it so that `nearest` can stop early
/// (`dist(a, b) >= (key(a) - key(b))^2`).
#[inline]
fn key_of(c: &Rgb) -> f32 {
    0.265 * c[0] + 0.657 * c[1] + 0.078 * c[2]
}

/// Seconds since the first call; always 0 on wasm, which has no clock in std.
fn now() -> f64 {
    #[cfg(not(target_arch = "wasm32"))]
    {
        static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        START.get_or_init(std::time::Instant::now).elapsed().as_secs_f64()
    }
    #[cfg(target_arch = "wasm32")]
    {
        0.0
    }
}

/// Tiny deterministic PRNG so runs are reproducible.
pub struct Rng(pub u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}
const SEED: u64 = 0x9E3779B97F4A7C15;

/// k-means++ seeded Lloyd iterations on a pixel sample, in the same weighted space as `dist`.
fn kmeans_palette(frames: &[&[Rgb]], k: usize, rng: &mut Rng, threads: usize) -> Vec<Rgb> {
    kmeans_palette_n(frames, k, rng, threads, 60000, 12)
}

/// k-means on at most `max_samples` sampled pixels with `iters` Lloyd iterations.
fn kmeans_palette_n(frames: &[&[Rgb]], k: usize, rng: &mut Rng, threads: usize, max_samples: usize, iters: usize) -> Vec<Rgb> {
    // sample pixels directly instead of materialising a list of every pixel of every frame
    let n: usize = frames.iter().map(|f| f.len()).sum();
    let sample: Vec<Rgb> = (0..n.min(max_samples))
        .map(|_| {
            let f = frames[(rng.next() % frames.len() as u64) as usize];
            f[(rng.next() % f.len() as u64) as usize]
        })
        .collect();
    // k-means++ seeding is inherently sequential (each pick depends on all previous ones), so
    // seed from a 16k subsample; the Lloyd iterations below still refine on the full sample
    let seed_set = &sample[..sample.len().min(16000)];
    let mut cents: Vec<Rgb> = vec![seed_set[0]];
    let mut dmin: Vec<f32> = seed_set.iter().map(|p| dist(p, &cents[0])).collect();
    while cents.len() < k {
        let total: f64 = dmin.iter().map(|&d| d as f64).sum();
        if total <= 0.0 {
            break;
        }
        let mut r = (rng.next() as f64 / u64::MAX as f64) * total;
        let mut pick = 0;
        for (i, &d) in dmin.iter().enumerate() {
            r -= d as f64;
            if r <= 0.0 {
                pick = i;
                break;
            }
        }
        let c = seed_set[pick];
        cents.push(c);
        for (p, d) in seed_set.iter().zip(dmin.iter_mut()) {
            *d = d.min(dist(p, &c));
        }
    }
    for _ in 0..iters {
        let by_green = green_index(&cents);
        let (bg, cs) = (&by_green, &cents);
        let assign = move |ps: &[Rgb]| {
            let mut acc = vec![[0f64; 4]; cs.len()];
            for p in ps {
                // Each pixel pulls on its colour in proportion to how badly it is served (plus a
                // floor): the palette then minimises roughly the 4th power of the error rather than
                // the square, so rare colours far from the rest (a patch of sky, a bright
                // highlight) aren't left to coarse dithering. SSIMULACRA2 pools errors the same way.
                // (whole-number weights keep the sums below exact, hence independent of chunking)
                let (b, d) = nearest(bg, cs, p);
                let (best, w) = (b as usize, d.round() as f64 + 4.0);
                for ch in 0..3 {
                    acc[best][ch] += p[ch] as f64 * w;
                }
                acc[best][3] += w;
            }
            acc
        };
        // sums of whole numbers are exact in f64, so the result doesn't depend on the chunking
        let parts: Vec<Vec<[f64; 4]>> = if threads <= 1 {
            vec![assign(&sample)]
        } else {
            let chunk = sample.len().div_ceil(threads);
            std::thread::scope(|sc| {
                let hs: Vec<_> = sample.chunks(chunk).map(|ps| sc.spawn(move || assign(ps))).collect();
                hs.into_iter().map(|h| h.join().unwrap()).collect()
            })
        };
        let mut acc = vec![[0f64; 4]; cents.len()];
        for part in &parts {
            for (a, b) in acc.iter_mut().zip(part) {
                for ch in 0..4 {
                    a[ch] += b[ch];
                }
            }
        }
        for (j, a) in acc.iter().enumerate() {
            if a[3] > 0.0 {
                cents[j] = [(a[0] / a[3]) as f32, (a[1] / a[3]) as f32, (a[2] / a[3]) as f32];
            }
        }
    }
    for c in cents.iter_mut() {
        for ch in c.iter_mut() {
            *ch = ch.round().clamp(0.0, 255.0);
        }
    }
    cents
}

/// Collects what the palette needs from a first pass over the frames: a fixed-size random
/// sample of opaque pixels (memory doesn't grow with clip length), an exact colour census
/// while the clip has few colours (screen recordings, cartoons, GIFs being re-compressed),
/// and whether any pixel is transparent.
pub struct PaletteBuilder {
    rng: Rng,
    pool: Vec<Rgb>,
    /// frame each pool sample came from
    pool_frame: Vec<u32>,
    seen: usize,
    census: Census,
    pub has_clear: bool,
    pub frames: usize,
    pub dims: Option<(usize, usize)>,
    /// most distinct opaque colours in any single frame (counted up to 256)
    pub max_frame_colors: usize,
    /// previous frame, and a sample of the colours that changed from one frame to the next
    /// (at most 256 per frame): the palette is ordered so these come first
    prev: Vec<u8>,
    chg: Vec<Rgb>,
    chg_seen: usize,
    chg_rng: Rng,
}
const CHG_CAP: usize = 65_536;

const POOL_CAP: usize = 250_000;
/// Largest palette-shrink tolerance (mean weighted squared error, about 4.5 levels RMS).
const MAX_PALETTE_TOL: f32 = 20.0;

/// Exact colour counts, abandoned once there are more distinct colours than `CENSUS_MAX`.
struct Census {
    keys: Vec<u32>,
    counts: Vec<u64>,
    len: usize,
    overflow: bool,
}
const CENSUS_MAX: usize = 4096;
const CENSUS_SLOTS: usize = 8192;
const EMPTY: u32 = u32::MAX;

impl Census {
    fn add(&mut self, k: u32) {
        let mut h = (k.wrapping_mul(0x9E37_79B1) >> 19) as usize;
        loop {
            let s = self.keys[h];
            if s == k {
                self.counts[h] += 1;
                return;
            }
            if s == EMPTY {
                if self.len == CENSUS_MAX {
                    self.overflow = true;
                    return;
                }
                self.keys[h] = k;
                self.counts[h] = 1;
                self.len += 1;
                return;
            }
            h = (h + 1) % CENSUS_SLOTS;
        }
    }
    /// (colour, count), most frequent first
    fn sorted(&self) -> Vec<(u32, u64)> {
        let mut v: Vec<(u32, u64)> = self.keys.iter().zip(&self.counts).filter(|(k, _)| **k != EMPTY).map(|(k, c)| (*k, *c)).collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        v
    }
}

impl Default for PaletteBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl PaletteBuilder {
    pub fn new() -> Self {
        PaletteBuilder {
            rng: Rng(SEED),
            pool: Vec::new(),
            pool_frame: Vec::new(),
            seen: 0,
            census: Census { keys: vec![EMPTY; CENSUS_SLOTS], counts: vec![0; CENSUS_SLOTS], len: 0, overflow: false },
            has_clear: false,
            frames: 0,
            dims: None,
            max_frame_colors: 0,
            prev: Vec::new(),
            chg: Vec::new(),
            chg_seen: 0,
            chg_rng: Rng(SEED ^ 0x5eed),
        }
    }

    /// `rgba`: w*h*4 bytes. Pixels with alpha < 128 count as transparent.
    pub fn add(&mut self, rgba: &[u8], w: usize, h: usize) {
        assert_eq!(rgba.len(), w * h * 4);
        self.dims.get_or_insert((w, h));
        self.frames += 1;
        if !self.has_clear && rgba.as_chunks::<4>().0.iter().any(|c| c[3] < 128) {
            self.has_clear = true;
        }
        if !self.census.overflow {
            for c in rgba.as_chunks::<4>().0 {
                if c[3] >= 128 {
                    self.census.add((c[0] as u32) << 16 | (c[1] as u32) << 8 | c[2] as u32);
                    if self.census.overflow {
                        break;
                    }
                }
            }
        }
        if self.max_frame_colors <= 255 {
            self.max_frame_colors = self.max_frame_colors.max(frame_census(rgba, 256).map_or(256, |c| c.len()));
        }
        let n = w * h;
        for _ in 0..4000 {
            let i = (self.rng.next() % n as u64) as usize;
            let c = &rgba[i * 4..i * 4 + 4];
            if c[3] < 128 {
                continue;
            }
            let px = [c[0] as f32, c[1] as f32, c[2] as f32];
            self.seen += 1;
            let f = (self.frames - 1) as u32;
            if self.pool.len() < POOL_CAP {
                self.pool.push(px);
                self.pool_frame.push(f);
            } else {
                let j = (self.rng.next() % self.seen as u64) as usize;
                if j < POOL_CAP {
                    self.pool[j] = px;
                    self.pool_frame[j] = f;
                }
            }
        }
        if self.prev.len() == rgba.len() {
            let changed: Vec<usize> =
                (0..n).filter(|&i| rgba[i * 4 + 3] >= 128 && rgba[i * 4..i * 4 + 4] != self.prev[i * 4..i * 4 + 4]).collect();
            for k in 0..changed.len().min(256) {
                let i = if changed.len() <= 256 { changed[k] } else { changed[(self.chg_rng.next() % changed.len() as u64) as usize] };
                let px = [rgba[i * 4] as f32, rgba[i * 4 + 1] as f32, rgba[i * 4 + 2] as f32];
                self.chg_seen += 1;
                if self.chg.len() < CHG_CAP {
                    self.chg.push(px);
                } else {
                    let j = (self.chg_rng.next() % self.chg_seen as u64) as usize;
                    if j < CHG_CAP {
                        self.chg[j] = px;
                    }
                }
            }
        }
        self.prev.clear();
        self.prev.extend_from_slice(rgba);
    }

    /// Colours that change often from frame to frame go first, so a frame that only repaints a
    /// few of them (a cursor, a caret, a small sprite) needs only low indices and therefore a
    /// small LZW code size (see `compact_frame`).
    fn order_by_change(&self, pal: Vec<Rgb>) -> Vec<Rgb> {
        if self.chg.is_empty() || pal.len() < 2 {
            return pal;
        }
        let bg = green_index(&pal);
        let mut counts = vec![0u32; pal.len()];
        for p in &self.chg {
            counts[nearest(&bg, &pal, p).0 as usize] += 1;
        }
        let mut order: Vec<usize> = (0..pal.len()).collect();
        // stable, so equal counts keep their order (insertion sort: at most 256 entries, and no
        // extra copy of the library's sort in the wasm build)
        for a in 1..order.len() {
            let mut b = a;
            while b > 0 && counts[order[b - 1]] < counts[order[b]] {
                order.swap(b - 1, b);
                b -= 1;
            }
        }
        order.iter().map(|&i| pal[i]).collect()
    }

    /// The whole clip has more colours than one palette holds.
    pub fn many_colours(&self) -> bool {
        self.census.overflow || self.census.len > 255
    }

    /// At most `colors` (<= 255) colours; the last index of the table stays free for transparency.
    ///
    /// `tol` lets the palette shrink: the smallest of 255/127/63/31/15/7 colours whose average
    /// quantization error is within `tol` of the full palette's (and within `2 * tol` on every
    /// frame) is used. `tol` is capped at `MAX_PALETTE_TOL`. Text, UI and dark scenes
    /// need far fewer than 255 colours, and every unneeded colour makes LZW strings shorter
    /// (credits went 23% smaller at the same quality with 32 colours instead of 255).
    pub fn build(&self, colors: usize, threads: usize, tol: f32) -> Vec<Rgb> {
        self.order_by_change(self.build_unordered(colors, threads, tol))
    }

    /// The palette `Encoder::new` needs for these settings: `build` with the size, threads and
    /// tolerance they ask for, or none at all when every frame gets its own (`p.local`).
    pub fn palette_for(&self, p: &Params) -> Vec<Rgb> {
        if p.local { vec![] } else { self.build(p.colors, p.threads, p.palette_tol * p.lambda) }
    }

    fn build_unordered(&self, colors: usize, threads: usize, tol: f32) -> Vec<Rgb> {
        let k = colors.clamp(1, 255);
        let rgb = |c: u32| [(c >> 16) as f32, ((c >> 8) & 255) as f32, (c & 255) as f32];
        let mut exact = None;
        if !self.census.overflow && self.census.len > 0 {
            let s = self.census.sorted();
            let total: u64 = s.iter().map(|e| e.1).sum();
            let covered: u64 = s.iter().take(k).map(|e| e.1).sum();
            // few enough colours to keep them exactly: zero quantization error. Also when a
            // handful of rare colours don't fit (e.g. a 256-colour GIF): they get the nearest.
            if s.len() <= k || covered as f64 >= 0.995 * total as f64 {
                exact = Some(s.iter().take(k).map(|e| rgb(e.0)).collect::<Vec<Rgb>>());
            }
        }
        if self.pool.is_empty() {
            return exact.unwrap_or_else(|| vec![[0.0; 3]]);
        }
        let full = match exact {
            Some(e) => e,
            None => {
                let far = far_colours(k);
                add_far_colours(kmeans_palette(&[self.pool.as_slice()], k - far, &mut Rng(self.rng.0), threads), far, &self.pool)
            }
        };
        if tol <= 0.0 {
            return full;
        }
        // Past this the saving is small and whole frames start to lose their colours (a 15-colour
        // palette on live action at low quality).
        let tol = tol.min(MAX_PALETTE_TOL);
        // test samples spread over the whole clip (the pool is in frame order until it fills)
        let step = (self.pool.len() / 30000).max(1);
        let test: Vec<(Rgb, u32)> = (0..self.pool.len()).step_by(step).map(|i| (self.pool[i], self.pool_frame[i])).collect();
        let nf = self.frames.max(1);
        // mean quantization error over the clip, and per frame
        let err = |pal: &[Rgb]| {
            let bg = green_index(pal);
            let mut per = vec![(0.0f64, 0u32); nf];
            for (p, f) in &test {
                let e = nearest(&bg, pal, p).1 as f64;
                per[*f as usize].0 += e;
                per[*f as usize].1 += 1;
            }
            let mean = per.iter().map(|e| e.0).sum::<f64>() / test.len() as f64;
            (mean, per.iter().map(|e| if e.1 >= 20 { Some(e.0 / e.1 as f64) } else { None }).collect::<Vec<_>>())
        };
        let (base, base_per) = err(&full);
        let mut best = full;
        // 2^n - 1 colours: the transparent index then fits in the same table size
        for kk in [127, 63, 31, 15, 7] {
            if kk >= best.len() {
                continue;
            }
            // a candidate of at most 127 colours settles on a smaller sample in fewer iterations
            let far = far_colours(kk);
            let pal = add_far_colours(
                kmeans_palette_n(&[self.pool.as_slice()], kk - far, &mut Rng(self.rng.0), threads, 20000, 8),
                far,
                &self.pool,
            );
            let (e, per) = err(&pal);
            // within budget on average, and no single frame much worse (a fade-in or one
            // colourful shot in a dark clip must not lose its colours)
            let worst = per.iter().zip(&base_per).filter_map(|(a, b)| Some(a.as_ref()? - b.as_ref()?)).fold(0.0, f64::max);
            if e - base > tol as f64 || worst > 2.0 * tol as f64 {
                break;
            }
            best = pal;
        }
        best
    }
}

/// Share of a k-means palette's entries given to the clip's worst-served colours instead.
const FAR_SHARE: f32 = 0.18;

fn far_colours(k: usize) -> usize {
    ((k as f32 * FAR_SHARE).round() as usize).min(k.saturating_sub(1))
}

/// Adds `far` colours one at a time, each the pool sample farthest from every palette colour so
/// far: the outliers k-means averages away (it serves the bulk of the pixels).
fn add_far_colours(mut pal: Vec<Rgb>, far: usize, pool: &[Rgb]) -> Vec<Rgb> {
    if far == 0 || pool.is_empty() {
        return pal;
    }
    let step = (pool.len() / 60000).max(1);
    let samp: Vec<Rgb> = pool.iter().step_by(step).copied().collect();
    let bg = green_index(&pal);
    let mut dmin: Vec<f32> = samp.iter().map(|p| nearest(&bg, &pal, p).1).collect();
    for _ in 0..far {
        let (bi, _) = dmin.iter().enumerate().fold((0, -1f32), |a, (i, &d)| if d > a.1 { (i, d) } else { a });
        let c = samp[bi];
        let c = [c[0].round(), c[1].round(), c[2].round()];
        pal.push(c);
        for (p, d) in samp.iter().zip(dmin.iter_mut()) {
            *d = d.min(dist(p, &c));
        }
    }
    pal
}

/// Exact opaque colours of one frame, most frequent first, if there are at most `cap`.
fn frame_census(rgba: &[u8], cap: usize) -> Option<Vec<(u32, u32)>> {
    const SLOTS: usize = 1024;
    let mut keys = [EMPTY; SLOTS];
    let mut counts = [0u32; SLOTS];
    let mut n = 0;
    for c in rgba.as_chunks::<4>().0 {
        if c[3] < 128 {
            continue;
        }
        let k = (c[0] as u32) << 16 | (c[1] as u32) << 8 | c[2] as u32;
        let mut h = (k.wrapping_mul(0x9E37_79B1) >> 22) as usize;
        loop {
            if keys[h] == k {
                counts[h] += 1;
                break;
            }
            if keys[h] == EMPTY {
                if n == cap {
                    return None;
                }
                keys[h] = k;
                counts[h] = 1;
                n += 1;
                break;
            }
            h = (h + 1) % SLOTS;
        }
    }
    let mut v: Vec<(u32, u32)> = keys.iter().zip(counts).filter(|(k, _)| **k != EMPTY).map(|(k, c)| (*k, c)).collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    Some(v)
}

struct BitWriter {
    out: Vec<u8>,
    acc: u32,
    nbits: u32,
}
impl BitWriter {
    fn put(&mut self, code: u32, width: u32) {
        self.acc |= code << self.nbits;
        self.nbits += width;
        while self.nbits >= 8 {
            self.out.push(self.acc as u8);
            self.acc >>= 8;
            self.nbits -= 8;
        }
    }
    fn finish(mut self) -> (Vec<u8>, usize) {
        let bits = self.out.len() * 8 + self.nbits as usize;
        if self.nbits > 0 {
            self.out.push(self.acc as u8);
        }
        (self.out, bits)
    }
    /// Append another bitstream at bit (not byte) granularity.
    fn append(&mut self, data: &[u8], bits: usize) {
        for (i, &b) in data.iter().enumerate() {
            let n = (bits - i * 8).min(8) as u32;
            self.put(b as u32 & ((1 << n) - 1), n);
        }
    }
}

/// LZW trie with first-child / next-sibling lists (cheap to reset on clear).
struct Lzw {
    mcs: u32,
    clear: u32,
    first_child: Vec<u16>,
    next_sibling: Vec<u16>,
    sym: Vec<u8>,
    next_code: u32,
    width: u32,
    bw: BitWriter,
    cur: Option<u16>,
}
const NONE: u16 = u16::MAX;

impl Lzw {
    /// `lead_clear`: only the first band of an image starts with a CLEAR code; later bands
    /// start with a fresh dictionary because the previous band ended with CLEAR.
    fn new(lead_clear: bool, mcs: u32) -> Self {
        let clear = 1u32 << mcs;
        let mut l = Lzw {
            mcs,
            clear,
            first_child: vec![NONE; 4096],
            next_sibling: vec![NONE; 4096],
            sym: vec![0; 4096],
            next_code: clear + 2,
            width: mcs + 1,
            bw: BitWriter { out: vec![], acc: 0, nbits: 0 },
            cur: None,
        };
        if lead_clear {
            l.bw.put(clear, mcs + 1);
        }
        for i in 0..clear as usize {
            l.sym[i] = i as u8;
        }
        l
    }
    fn reset_dict(&mut self) {
        for c in self.first_child.iter_mut() {
            *c = NONE;
        }
        self.next_code = self.clear + 2;
        self.width = self.mcs + 1;
    }
    fn children(&self, node: u16) -> ChildIter<'_> {
        ChildIter { l: self, c: self.first_child[node as usize] }
    }
    /// Extend current string with a child node known to exist.
    fn extend(&mut self, child: u16) {
        self.cur = Some(child);
    }
    /// Emit the current string and start a new one with symbol `s`.
    fn start(&mut self, s: u8) {
        if let Some(c) = self.cur {
            self.bw.put(c as u32, self.width);
            if self.next_code < 4096 {
                let n = self.next_code as u16;
                self.sym[n as usize] = s;
                self.first_child[n as usize] = NONE;
                self.next_sibling[n as usize] = self.first_child[c as usize];
                self.first_child[c as usize] = n;
                self.next_code += 1;
                if self.next_code - 1 == (1 << self.width) && self.width < 12 {
                    self.width += 1;
                }
                if self.next_code == 4096 {
                    self.bw.put(self.clear, self.width);
                    self.reset_dict();
                }
            }
        }
        self.cur = Some(s as u16);
    }
    /// Append symbol `s` exactly: extend the current string if the dictionary allows it.
    fn push_exact(&mut self, s: u8) {
        let hit = self.cur.and_then(|cur| self.children(cur).find(|&(_, x)| x == s).map(|(c, _)| c));
        match hit {
            Some(c) => self.extend(c),
            None => self.start(s),
        }
    }
    /// Ends the band: EOI for the last band, otherwise CLEAR (at the decoder's current code
    /// width) so the next band can be encoded independently with a fresh dictionary.
    fn finish(mut self, last: bool) -> (Vec<u8>, usize) {
        if let Some(c) = self.cur {
            self.bw.put(c as u32, self.width);
            if self.next_code < 4096 {
                self.next_code += 1;
                if self.next_code - 1 == (1 << self.width) && self.width < 12 {
                    self.width += 1;
                }
            }
        }
        self.bw.put(if last { self.clear + 1 } else { self.clear }, self.width);
        self.bw.finish()
    }
}
struct ChildIter<'a> {
    l: &'a Lzw,
    c: u16,
}
impl Iterator for ChildIter<'_> {
    type Item = (u16, u8);
    fn next(&mut self) -> Option<(u16, u8)> {
        if self.c == NONE {
            return None;
        }
        let c = self.c;
        self.c = self.l.next_sibling[c as usize];
        Some((c, self.l.sym[c as usize]))
    }
}

/// Lossless LZW of a finished index array (used to re-encode a frame with a grown rectangle).
fn lzw_indices(idx: &[u8], mcs: u32) -> Vec<u8> {
    let mut l = Lzw::new(true, mcs);
    for &s in idx {
        l.push_exact(s);
    }
    l.finish(true).0
}

/// Everything a band encoder reads about the current frame.
struct Ctx<'a> {
    src: &'a [Rgb],
    canvas: &'a [Rgb],
    painted: &'a [Rgb],
    tclear: Option<&'a [bool]>, // target pixel is transparent (alpha output only)
    cclear: Option<&'a [bool]>, // canvas pixel currently shows nothing (alpha output only)
    w: usize,
    pal: &'a [Rgb],
    tidx: Option<u8>,
    p: &'a Params,
    dmap: Option<&'a [f32]>,     // per-pixel dithering strength
    tex: Option<&'a [[f32; 2]]>, // per-pixel (lambda, tbias) multipliers (texture masking)
    opaque: bool,                // don't use "keep": paint every opaque pixel with a palette colour
    mcs: u32,                    // LZW minimum code size
    ti: u8,                      // the transparent index (forced for transparent target pixels)
}

/// Encode one rectangle of a frame. Returns (lzw bytes, chosen indices).
///
/// The rectangle is cut into horizontal bands that are encoded on separate threads. Each band
/// ends with an LZW CLEAR code, so the decoder resets its dictionary exactly where the next band's
/// independent bitstream begins; the bitstreams are then concatenated at bit granularity.
fn encode_rect(ctx: &Ctx, rect: Rect, max_bands: usize) -> (Vec<u8>, Vec<u8>) {
    let (_, _, rw, rh) = rect;
    // palette sorted by brightness (`key_of`): its squared difference is a lower bound on
    // dist(), which lets the nearest-colour search stop early instead of scanning all 255 colours
    let by_green = green_index(ctx.pal);
    // bands narrower than ~32 rows cost more in dictionary resets than they save in time
    let nb = max_bands.clamp(1, (rh / 32).max(1));
    let bounds: Vec<(usize, usize)> = (0..nb).map(|i| (rh * i / nb, rh * (i + 1) / nb)).collect();
    let by_green = &by_green;
    let bands: Vec<(Vec<u8>, usize, Vec<u8>)> = if nb == 1 {
        vec![encode_band(ctx, rect, 0, rh, by_green, true, true)]
    } else {
        std::thread::scope(|sc| {
            let hs: Vec<_> = bounds
                .iter()
                .enumerate()
                .map(|(i, &(ya, yb))| sc.spawn(move || encode_band(ctx, rect, ya, yb, by_green, i == 0, i == nb - 1)))
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        })
    };
    let mut bw = BitWriter { out: vec![], acc: 0, nbits: 0 };
    let mut idx = Vec::with_capacity(rw * rh);
    for (data, bits, bidx) in &bands {
        bw.append(data, *bits);
        idx.extend_from_slice(bidx);
    }
    (bw.finish().0, idx)
}

/// Encode rows `ya..yb` of the rectangle as one independent LZW run.
fn encode_band(ctx: &Ctx, rect: Rect, ya: usize, yb: usize, by_green: &[(f32, u8)], first: bool, last: bool) -> (Vec<u8>, usize, Vec<u8>) {
    let (x0, y0, rw, _) = rect;
    let (src, canvas, pal, tidx, p) = (ctx.src, ctx.canvas, ctx.pal, ctx.tidx, ctx.p);
    let mut lzw = Lzw::new(first, ctx.mcs);
    let mut idx = vec![0u8; rw * (yb - ya)];
    let mut err = vec![[0f32; 3]; (rw + 2) * 2];
    let colour_of = |i: u8, pos: usize| -> Rgb { if Some(i) == tidx { canvas[pos] } else { pal[i as usize] } };
    for (by, y) in (ya..yb).enumerate() {
        let (cur_row, next_row) = if by % 2 == 0 { (0, rw + 2) } else { (rw + 2, 0) };
        for e in err[next_row..next_row + rw + 2].iter_mut() {
            *e = [0.0; 3];
        }
        for x in 0..rw {
            let pos = (y0 + y) * ctx.w + x0 + x;
            // a transparent target pixel can only be the transparent index (the canvas under it
            // is already clear: the encoder disposes the previous frame when it isn't). It takes
            // no part in error diffusion.
            if ctx.tclear.is_some_and(|c| c[pos]) {
                lzw.push_exact(ctx.ti);
                idx[by * rw + x] = ctx.ti;
                continue;
            }
            let canvas_clear = ctx.cclear.is_some_and(|c| c[pos]);
            let bonus = p.canvas_bonus && tidx.is_some() && !canvas_clear;
            let canvas_clear = canvas_clear || ctx.opaque;
            let m = ctx.dmap.map_or(1.0, |d| d[pos]);
            let (mut tbias, mut lambda) = if m == 0.0 { (p.tbias * p.flat_tight, p.lambda * p.flat_tight) } else { (p.tbias, p.lambda) };
            if let Some(tx) = ctx.tex {
                lambda *= tx[pos][0];
                tbias *= tx[pos][1];
            }
            let e = err[cur_row + x + 1];
            let t: Rgb = [src[pos][0] + e[0] * m, src[pos][1] + e[1] * m, src[pos][2] + e[2] * m];

            // Temporal denoise: if the source pixel is within `gate` of the source colour it had
            // when it was last painted, leave it alone. Without this, codec noise and the chaotic
            // nature of error diffusion keep "improving" still areas frame after frame, which
            // costs bytes and stops still scenes from collapsing into a single frame.
            let forced_keep = tidx.is_some() && !canvas_clear && dist(&src[pos], &ctx.painted[pos]) <= p.gate;
            let chosen;
            if forced_keep {
                let ti = tidx.unwrap();
                lzw.push_exact(ti);
                chosen = ti;
            } else {
                // "keep previous pixel" candidate (cheap: one distance); impossible where the
                // canvas shows nothing
                let d_keep = match tidx {
                    Some(_) if !canvas_clear => dist(&t, &canvas[pos]) - tbias,
                    _ => f32::MAX,
                };

                // best "extend string" candidate among the current node's children
                let mut ext: Option<(u16, u8)> = None;
                let mut d_ext = f32::MAX;
                if let Some(cur) = lzw.cur {
                    for (child, s) in lzw.children(cur) {
                        let d = if Some(s) == tidx {
                            if canvas_clear {
                                continue;
                            }
                            dist(&t, &canvas[pos]) - tbias
                        } else if bonus && pal[s as usize] == canvas[pos] {
                            // shows exactly what keeping the pixel would: same cost as keeping,
                            // so an unchanged area doesn't break the LZW string to go transparent
                            dist(&t, &canvas[pos]) - tbias
                        } else {
                            dist(&t, &pal[s as usize])
                        };
                        if d < d_ext {
                            d_ext = d;
                            ext = Some((child, s));
                        }
                    }
                }

                // Palette distances are >= 0, so the best new code can never beat min(0, d_keep).
                // If extending is already within lambda of that bound it wins regardless, and the
                // (expensive) nearest-colour search can be skipped. Decisions are unchanged.
                if let Some((c, s)) = ext
                    && d_ext <= d_keep.min(0.0) + lambda
                {
                    lzw.extend(c);
                    chosen = s;
                } else {
                    let (mut best_new, mut d_new) = nearest(by_green, pal, &t);
                    if let Some(ti) = tidx
                        && d_keep <= d_new
                    {
                        d_new = d_keep;
                        best_new = ti;
                    }
                    match ext {
                        Some((c, s)) if d_ext <= d_new + lambda => {
                            lzw.extend(c);
                            chosen = s;
                        }
                        _ => {
                            lzw.start(best_new);
                            chosen = best_new;
                        }
                    }
                }
            }
            idx[by * rw + x] = chosen;

            let got = colour_of(chosen, pos);
            let q = p.dither * m;
            let d = [t[0] - got[0], t[1] - got[1], t[2] - got[2]];
            // the colour part of the error is diffused a little less than the brightness part
            let ly = 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2];
            let mut ee = [0f32; 3];
            for ch in 0..3 {
                ee[ch] = ((ly + (d[ch] - ly) * CHROMA_DIFFUSION) * q).clamp(-p.errclamp, p.errclamp);
            }
            // Floyd-Steinberg-like weights, but with less to the right (5/16 instead of 7/16): the
            // next pixel's target moves less, so LZW strings run longer; the row below still
            // takes up the rest, which keeps local averages right.
            for ch in 0..3 {
                err[cur_row + x + 2][ch] += ee[ch] * 5.0 / 16.0;
                err[next_row + x][ch] += ee[ch] * 3.0 / 16.0;
                err[next_row + x + 1][ch] += ee[ch] * 5.0 / 16.0;
                err[next_row + x + 2][ch] += ee[ch] * 3.0 / 16.0;
            }
        }
    }
    let (data, bits) = lzw.finish(last);
    (data, bits, idx)
}

/// Palette entries sorted by brightness (`key_of`), for `nearest`.
fn green_index(pal: &[Rgb]) -> Vec<(f32, u8)> {
    let mut v: Vec<(f32, u8)> = pal.iter().enumerate().map(|(i, c)| (key_of(c), i as u8)).collect();
    v.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    v
}

/// Exact nearest palette colour, searching outward from the target's brightness.
fn nearest(by_green: &[(f32, u8)], pal: &[Rgb], t: &Rgb) -> (u8, f32) {
    let tk = key_of(t);
    let start = by_green.partition_point(|e| e.0 < tk);
    let (mut best, mut bd) = (0u8, f32::MAX);
    let (mut lo, mut hi) = (start as isize - 1, start);
    loop {
        let mut progressed = false;
        if hi < by_green.len() {
            let (g, i) = by_green[hi];
            let dg = g - tk;
            if dg * dg < bd {
                let d = dist(t, &pal[i as usize]);
                if d < bd {
                    bd = d;
                    best = i;
                }
                hi += 1;
                progressed = true;
            } else {
                hi = by_green.len();
            }
        }
        if lo >= 0 {
            let (g, i) = by_green[lo as usize];
            let dg = tk - g;
            if dg * dg < bd {
                let d = dist(t, &pal[i as usize]);
                if d < bd {
                    bd = d;
                    best = i;
                }
                lo -= 1;
                progressed = true;
            } else {
                lo = -1;
            }
        }
        if !progressed {
            return (best, bd);
        }
    }
}

fn write_sub_blocks(out: &mut Vec<u8>, data: &[u8]) {
    for chunk in data.chunks(255) {
        out.push(chunk.len() as u8);
        out.extend_from_slice(chunk);
    }
    out.push(0);
}

fn palette_bytes(pal: &[Rgb], mcs: u32) -> Vec<u8> {
    let mut v = Vec::with_capacity(3 << mcs);
    for i in 0..1usize << mcs {
        let c = pal.get(i).copied().unwrap_or([0.0; 3]);
        v.extend([c[0] as u8, c[1] as u8, c[2] as u8]);
    }
    v
}

/// A frame that uses only a few palette entries can be coded with a smaller LZW alphabet:
/// either the global palette with the transparent index moved to the lowest free entry (when
/// the entries it uses are all low), or a small local palette of just those colours. Codes are
/// then 2-7 bits instead of 9, which roughly halves small frames (a cursor, a blinking caret).
/// Same pixels either way. Returns (mcs, transparent index or None, data, local palette) when
/// smaller than `data`.
///
/// `keep_t`: keep a transparent index even when no pixel uses it. With transparency in the
/// output that matters: Pillow (unlike browsers) fills a "restore to background" area with the
/// background colour, not transparency, when the frames don't declare a transparent index.
fn compact_frame(
    idx: &[u8],
    data: &[u8],
    pal: &[Rgb],
    mcs: u32,
    ti: u8,
    transparent: bool,
    keep_t: bool,
    local: bool,
) -> Option<(u32, Option<u8>, Vec<u8>, Option<Vec<Rgb>>)> {
    // a frame's own palette is written with 2^mcs entries
    let table = |m: u32| if local { 3usize << m } else { 0 };
    let mut used = [false; 256];
    for &i in idx {
        used[i as usize] = true;
    }
    let needs_t = transparent && (keep_t || used[ti as usize]);
    if transparent {
        used[ti as usize] = false;
    }
    let nused = used.iter().filter(|&&u| u).count();
    let max_used = (0..256).rev().find(|&i| used[i]).unwrap_or(0);
    // smallest code size whose alphabet holds index `top`
    let size_for = |top: usize| {
        let mut m = 2;
        while (1usize << m) <= top {
            m += 1;
        }
        m
    };
    let t_a = (0..256).find(|&i| !used[i]).unwrap_or(ti as usize);
    let m_a = size_for(if needs_t { max_used.max(t_a) } else { max_used });
    let m_b = size_for(nused + needs_t as usize - 1);
    let mut best: Option<(u32, Option<u8>, Vec<u8>, Option<Vec<Rgb>>)> = None;
    let mut best_len = data.len() + table(mcs);
    if m_a < mcs {
        let remapped: Vec<u8> = idx.iter().map(|&i| if i == ti { t_a as u8 } else { i }).collect();
        let d = lzw_indices(&remapped, m_a);
        if d.len() + table(m_a) < best_len {
            best_len = d.len() + table(m_a);
            // a local palette keeps its entries (only the first 2^m_a are written)
            best = Some((m_a, needs_t.then_some(t_a as u8), d, None));
        }
    }
    if m_b < m_a.min(mcs) {
        let mut map = [0u8; 256];
        let mut lp = Vec::with_capacity(nused + 1);
        for i in 0..256 {
            if used[i] {
                map[i] = lp.len() as u8;
                lp.push(pal.get(i).copied().unwrap_or([0.0; 3]));
            }
        }
        let t_b = lp.len() as u8;
        map[ti as usize] = t_b;
        let remapped: Vec<u8> = idx.iter().map(|&i| map[i as usize]).collect();
        let d = lzw_indices(&remapped, m_b);
        if d.len() + (3 << m_b) < best_len {
            best = Some((m_b, needs_t.then_some(t_b), d, Some(lp)));
        }
    }
    best
}

/// Output frame held back one step: the next frame may only extend its delay, or may need
/// it to clear its area afterwards (disposal "restore to background").
struct Pending {
    rect: Rect,
    data: Vec<u8>,
    idx: Vec<u8>,
    lpal: Option<Vec<Rgb>>,
    /// LZW code size and transparent index `data` was coded with (a frame with its own
    /// palette has its own)
    mcs: u32,
    ti: u8,
    delay: u32,
    dispose_bg: bool,
}

#[derive(Default, Debug, Clone)]
pub struct Stats {
    pub frames_in: usize,
    pub frames_written: usize,
    pub bytes: usize,
    pub pass1_s: f64,
    pub pass2_s: f64,
    pub opaque_frames: usize,
    pub compact_frames: usize,
    pub own_palette_frames: usize,
}

/// Guesses whether re-encoding a changed area without transparency could come out smaller,
/// from the transparent encode's share of kept pixels and how fragmented they are. Measured on
/// 27,000 frames: above 92% kept it practically never wins; scattered keeps (many runs) and
/// the two frames right after a win often do. In between it learns per clip which kept share wins and
/// re-checks every 8th frame. It skips about 64% of the re-encodes for +0.01% bytes overall.
/// Own per-frame palettes (`Encoder::own_palette`) only at or below this lambda (quality ~90+),
/// and only when the shared palette's mean error on the frame's new colours exceeds
/// `LOCAL_ERR_MIN + lambda / 2` (weighted squared, see `dist`), or any error at all when lossless.
const LOCAL_MAX_LAMBDA: f32 = 10.0;
const LOCAL_ERR_MIN: f32 = 1.0;

/// Changed areas up to this many pixels always get the opaque re-encode (see `push`).
const SMALL_RECT: usize = 4096;

struct OpaqueGuess {
    win_below: f32,
    lose_above: f32,
    since: u32,
    boost: u32,
}

impl OpaqueGuess {
    fn new() -> Self {
        OpaqueGuess { win_below: -1.0, lose_above: 2.0, since: 0, boost: 0 }
    }

    /// `keep`: share of the area left transparent; `frag`: keep/change boundaries per kept pixel.
    fn want(&mut self, keep: f32, frag: f32) -> bool {
        self.since += 1;
        if self.boost > 0 {
            self.boost -= 1;
            return true;
        }
        if keep > 0.92 {
            return false;
        }
        frag >= 0.4 || keep <= 0.47 || keep <= self.win_below + 0.02 || keep < self.lose_above - 0.02 || self.since >= 8
    }

    /// `ratio`: opaque bytes / transparent bytes.
    fn report(&mut self, keep: f32, won: bool, ratio: f32) {
        self.since = 0;
        if won {
            self.win_below = self.win_below.max(keep);
            self.boost = 2;
        } else if ratio > 1.03 {
            self.lose_above = self.lose_above.min(keep);
        }
    }
}

/// Streaming encoder: push frames one at a time; memory is a few frame-sized buffers.
pub struct Encoder<W: Write> {
    out: W,
    mcs: u32,
    ti: u8,
    w: usize,
    h: usize,
    p: Params,
    pal: Vec<Rgb>,
    pal_set: Vec<u64>,
    alpha: bool,
    canvas: Vec<Rgb>,
    painted: Vec<Rgb>, // source colour at the time each pixel was last painted
    clear: Vec<bool>,  // canvas pixel shows nothing (alpha output only)
    pending: Option<Pending>,
    rng: Rng,
    /// When to try the opaque re-encode (see `want_opaque`).
    opq: OpaqueGuess,
    /// previous input frame (only kept while own per-frame palettes are possible)
    prev_src: Vec<u8>,
    /// Test oracle: receives the exact picture each written frame is meant to show
    /// (RGB bytes, or RGBA with transparent = 0,0,0,0 when the output has alpha).
    pub dump: Option<Box<dyn Write>>,
    pub stats: Stats,
}

impl<W: Write> Encoder<W> {
    /// `pal`: global palette (<= 255 colours; ignored with `p.local`). `alpha`: some frames
    /// have transparent pixels that must stay transparent in the output.
    pub fn new(mut out: W, w: usize, h: usize, pal: Vec<Rgb>, p: Params, alpha: bool) -> std::io::Result<Self> {
        if w == 0 || h == 0 || w > 65535 || h > 65535 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("{w}x{h} is not a size GIF allows")));
        }
        let mcs = code_size(if p.local { p.colors.clamp(1, 255) } else { pal.len() });
        let ti = ((1u32 << mcs) - 1) as u8;
        let mut hdr: Vec<u8> = b"GIF89a".to_vec();
        hdr.extend((w as u16).to_le_bytes());
        hdr.extend((h as u16).to_le_bytes());
        hdr.push(if p.local { 0x70 } else { 0xF0 | (mcs as u8 - 1) });
        hdr.extend([if alpha { ti } else { 0 }, 0]);
        if !p.local {
            hdr.extend(palette_bytes(&pal, mcs));
        }
        if let Some(n) = p.loop_count {
            hdr.extend([0x21, 0xFF, 0x0B]);
            hdr.extend(b"NETSCAPE2.0");
            hdr.extend([3, 1]);
            hdr.extend(n.to_le_bytes());
            hdr.push(0);
        }
        out.write_all(&hdr)?;
        Ok(Encoder {
            out,
            mcs,
            ti,
            w,
            h,
            pal_set: if p.local { vec![] } else { colour_set(&pal) },
            p,
            pal,
            alpha,
            canvas: vec![[0.0; 3]; w * h],
            painted: vec![[0.0; 3]; w * h],
            clear: if alpha { vec![true; w * h] } else { vec![] },
            pending: None,
            rng: Rng(SEED),
            opq: OpaqueGuess::new(),
            prev_src: Vec::new(),
            dump: None,
            stats: Stats { bytes: hdr.len(), ..Default::default() },
        })
    }

    fn write_pending(&mut self) -> std::io::Result<()> {
        if let Some(pd) = self.pending.take() {
            let first = self.stats.frames_written == 0;
            let mut b = Vec::with_capacity(pd.data.len() + pd.data.len() / 255 + 800);
            // GIF delays are 16-bit centiseconds; very long static stretches are split in push()
            let disposal: u8 = if pd.dispose_bg { 2 } else { 1 };
            let mut transparent = self.alpha || !first;
            let (mut mcs, mut ti, mut data, mut lpal) = (pd.mcs, pd.ti, pd.data, pd.lpal);
            if self.p.compact {
                let pal = lpal.as_deref().unwrap_or(&self.pal);
                if let Some((m, t, d, lp)) = compact_frame(&pd.idx, &data, pal, mcs, ti, transparent, self.alpha, lpal.is_some()) {
                    let was_local = lpal.take();
                    (mcs, data) = (m, d);
                    lpal = lp.or(was_local);
                    match t {
                        Some(t) => ti = t,
                        None => transparent = false,
                    }
                    self.stats.compact_frames += 1;
                }
            }
            b.extend([0x21, 0xF9, 4, (disposal << 2) | transparent as u8]);
            b.extend((pd.delay.min(65535) as u16).to_le_bytes());
            b.extend([ti, 0]);
            b.push(0x2C);
            for v in [pd.rect.0, pd.rect.1, pd.rect.2, pd.rect.3] {
                b.extend((v as u16).to_le_bytes());
            }
            match &lpal {
                Some(lp) => {
                    b.push(0x80 | (mcs as u8 - 1));
                    b.extend(palette_bytes(lp, mcs));
                }
                None => b.push(0),
            }
            b.push(mcs as u8); // LZW minimum code size
            write_sub_blocks(&mut b, &data);
            self.out.write_all(&b)?;
            self.stats.frames_written += 1;
            self.stats.bytes += b.len();
        }
        Ok(())
    }

    /// No error allowed anywhere (quality 100): every frame must show exactly its source,
    /// wherever a palette per frame can hold the colours it changes.
    fn lossless(&self) -> bool {
        self.p.lambda <= 0.0 && self.p.tbias <= 0.0
    }

    fn dump_canvas(&mut self) -> std::io::Result<()> {
        if let Some(d) = self.dump.as_mut() {
            let bytes: Vec<u8> = if self.alpha {
                self.canvas
                    .iter()
                    .zip(&self.clear)
                    .flat_map(|(p, &c)| if c { [0, 0, 0, 0] } else { [p[0] as u8, p[1] as u8, p[2] as u8, 255] })
                    .collect()
            } else {
                self.canvas.iter().flat_map(|p| [p[0] as u8, p[1] as u8, p[2] as u8]).collect()
            };
            d.write_all(&bytes)?;
        }
        Ok(())
    }

    /// Near-lossless only: when the colours this frame has to paint (those that differ from
    /// what is on screen) fit in 255 and the shared palette is noticeably off for them, the frame
    /// gets its own exact palette. GIFs made with a palette per frame (e.g. by gifski) can then
    /// be re-compressed without losing colours.
    fn own_palette(&self, rgba: &[u8], first: bool) -> Option<Vec<(u32, u32)>> {
        if !self.p.local_auto || self.p.lambda > LOCAL_MAX_LAMBDA || self.pal.is_empty() {
            return None;
        }
        // the pixels the input itself repainted (a GIF made with per-frame palettes repaints
        // only what changed, with that frame's palette)
        let fresh = first || self.prev_src.len() != rgba.len();
        let mut chg = Vec::new();
        for (i, c) in rgba.as_chunks::<4>().0.iter().enumerate() {
            if c[3] >= 128 && (fresh || (self.alpha && self.clear[i]) || *c != self.prev_src[i * 4..i * 4 + 4]) {
                chg.extend_from_slice(c);
            }
        }
        if chg.is_empty() {
            return None;
        }
        // a first frame without transparency may use all 256 entries
        let cs = frame_census(&chg, if first && !self.alpha { 256 } else { 255 })?;
        let bg = green_index(&self.pal);
        let (mut e, mut n) = (0f64, 0f64);
        for &(k, cnt) in &cs {
            let c = [(k >> 16) as f32, ((k >> 8) & 255) as f32, (k & 255) as f32];
            e += nearest(&bg, &self.pal, &c).1 as f64 * cnt as f64;
            n += cnt as f64;
        }
        // lossless takes its own palette for any error at all
        let min = if self.lossless() { 0.0 } else { LOCAL_ERR_MIN as f64 };
        (e / n > min + 0.5 * self.p.lambda as f64).then_some(cs)
    }

    /// Add one frame: `rgba` is w*h*4 bytes (alpha < 128 = transparent, used only when the
    /// encoder was created with `alpha`), shown for `delay` centiseconds.
    pub fn push(&mut self, rgba: &[u8], delay: u32) -> std::io::Result<()> {
        let (w, h) = (self.w, self.h);
        if rgba.len() != w * h * 4 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "frame size changed mid-stream"));
        }
        let src: Vec<Rgb> = rgba.as_chunks::<4>().0.iter().map(|c| [c[0] as f32, c[1] as f32, c[2] as f32]).collect();
        let tclear: Option<Vec<bool>> = self.alpha.then(|| rgba.as_chunks::<4>().0.iter().map(|c| c[3] < 128).collect());
        let first = self.stats.frames_in == 0;
        self.stats.frames_in += 1;
        // Alpha: a pixel that must turn transparent can only be cleared by disposing the previous
        // frame to background. Grow the previous frame's rectangle (padding it with transparent
        // pixels, which changes nothing it shows) to cover those pixels and mark it for disposal;
        // everything inside that rectangle then has to be repainted by this frame (so this comes
        // before the own-palette census, which must include those pixels).
        let mut must_emit = false;
        if let (Some(tc), false) = (&tclear, first) {
            let (mut xa, mut ya, mut xb, mut yb) = (w, h, 0, 0);
            for y in 0..h {
                for x in 0..w {
                    let i = y * w + x;
                    if tc[i] && !self.clear[i] {
                        xa = xa.min(x);
                        ya = ya.min(y);
                        xb = xb.max(x);
                        yb = yb.max(y);
                    }
                }
            }
            if xb >= xa {
                let pd = self.pending.as_mut().unwrap();
                let (px, py, pw, ph) = pd.rect;
                let (nx, ny) = (px.min(xa), py.min(ya));
                let (nw, nh) = ((px + pw).max(xb + 1) - nx, (py + ph).max(yb + 1) - ny);
                if (nx, ny, nw, nh) != pd.rect {
                    let mut idx = vec![pd.ti; nw * nh];
                    for y in 0..ph {
                        let d = (py + y - ny) * nw + px - nx;
                        idx[d..d + pw].copy_from_slice(&pd.idx[y * pw..(y + 1) * pw]);
                    }
                    pd.data = lzw_indices(&idx, pd.mcs);
                    pd.idx = idx;
                    pd.rect = (nx, ny, nw, nh);
                }
                pd.dispose_bg = true;
                for y in ny..ny + nh {
                    self.clear[y * w + nx..y * w + nx + nw].fill(true);
                }
                must_emit = true;
            }
        }

        let exact_local = if self.p.local { frame_census(rgba, self.p.colors.clamp(1, 255)) } else { self.own_palette(rgba, first) };
        if self.p.local_auto && self.p.lambda <= LOCAL_MAX_LAMBDA {
            self.prev_src.clear();
            self.prev_src.extend_from_slice(rgba);
        }
        let is_local = self.p.local || exact_local.is_some();
        if is_local && !self.p.local {
            self.stats.own_palette_frames += 1;
        }
        let pal: Vec<Rgb> = if let Some(c) = exact_local {
            // per-frame palettes (e.g. a GIF made by gifski) kept exactly
            let rgb = |c: u32| [(c >> 16) as f32, ((c >> 8) & 255) as f32, (c & 255) as f32];
            if c.is_empty() { vec![[0.0; 3]] } else { c.iter().map(|e| rgb(e.0)).collect() }
        } else if self.p.local {
            let opaque: Vec<Rgb> = match &tclear {
                Some(tc) => src.iter().zip(tc).filter(|(_, c)| !**c).map(|(p, _)| *p).collect(),
                None => src.clone(),
            };
            if opaque.is_empty() {
                vec![[0.0; 3]]
            } else {
                kmeans_palette(&[opaque.as_slice()], self.p.colors.min(255), &mut self.rng, self.p.threads)
            }
        } else {
            self.pal.clone()
        };
        let (ti, mcs) = if is_local && !self.p.local {
            // (256 colours only on a first frame without transparency, which has no transparent index)
            let m = code_size(pal.len()).min(8);
            (((1u32 << m) - 1) as u8, m)
        } else {
            (self.ti, self.mcs)
        };
        let t = if first && !self.alpha { None } else { Some(ti) };

        let local_set = is_local.then(|| colour_set(&pal));
        let set = local_set.as_ref().unwrap_or(&self.pal_set);
        let in_pal = |c: &Rgb| {
            let k = (c[0] as usize) << 16 | (c[1] as usize) << 8 | c[2] as usize;
            set[k >> 6] & (1 << (k & 63)) != 0
        };
        let dmap = dither_map(&src, w, h, &self.p, &in_pal);
        let tex = self.p.mask.then(|| texture_map(&src, w, h));
        let ctx = Ctx {
            src: &src,
            canvas: &self.canvas,
            painted: &self.painted,
            tclear: tclear.as_deref(),
            cclear: self.alpha.then_some(self.clear.as_slice()),
            w,
            pal: &pal,
            tidx: t,
            p: &self.p,
            dmap: dmap.as_deref(),
            tex: tex.as_deref(),
            opaque: false,
            mcs,
            ti,
        };
        let full = (0, 0, w, h);
        let mut est_frame_bytes = (w * h * 3 / 8) as f64; // keyframe guess: ~3 bits per pixel
        let rect = if !first {
            let tt = now();
            // this pass only locates the changed area; its bitstream is thrown away, so
            // splitting it into bands costs nothing in output size
            let (data, idx) = encode_rect(&ctx, full, self.p.threads);
            est_frame_bytes = data.len() as f64;
            self.stats.pass1_s += now() - tt;
            // A pixel only counts as changed if its colour actually differs from what is already
            // on screen. (An LZW string can re-paint a pixel with the same colour it already has;
            // that must not keep a still scene from collapsing into one long frame.)
            let (mut xa, mut ya, mut xb, mut yb) = (w, h, 0, 0);
            for y in 0..h {
                for x in 0..w {
                    let q = y * w + x;
                    let i = idx[q];
                    if i != ti && ((self.alpha && self.clear[q]) || pal[i as usize] != self.canvas[q]) {
                        xa = xa.min(x);
                        ya = ya.min(y);
                        xb = xb.max(x);
                        yb = yb.max(y);
                    }
                }
            }
            if xb < xa && !must_emit {
                // nothing changed: extend the pending frame's delay (split if it would overflow)
                let pd = self.pending.as_mut().unwrap();
                if pd.delay + delay > 65535 {
                    self.write_pending()?;
                    // a 1x1 fully transparent frame carries the rest of the pause
                    self.pending = Some(Pending {
                        rect: (0, 0, 1, 1),
                        data: lzw_indices(&[self.ti], self.mcs),
                        idx: vec![self.ti],
                        lpal: None,
                        mcs: self.mcs,
                        ti: self.ti,
                        delay,
                        dispose_bg: false,
                    });
                    self.dump_canvas()?;
                } else {
                    pd.delay += delay;
                }
                return Ok(());
            }
            if xb < xa {
                // only the disposal changed what's on screen; a 1x1 frame makes it take effect
                (0, 0, 1, 1)
            } else {
                (xa, ya, xb - xa + 1, yb - ya + 1)
            }
        } else {
            full
        };
        let tt = now();
        // Every extra band restarts the LZW dictionary (~60-100 bytes), so only split when
        // each band is expected to carry enough bytes for that to be negligible.
        let est = est_frame_bytes * (rect.2 * rect.3) as f64 / (w * h) as f64;
        let bands =
            if self.p.band_bytes == 0 { self.p.threads } else { self.p.threads.min((est / self.p.band_bytes as f64) as usize).max(1) };
        let (mut data, mut idx) = encode_rect(&ctx, rect, bands);
        // Transparency isn't always the cheaper way to say "unchanged": when most of the area
        // moved (scrolling, panning), painting unchanged pixels with their (identical) colour
        // gives LZW cleaner strings. Try that too and keep whichever is smaller.
        // That second encode doubles the work, so it is only tried when it might win.
        // A small area (a cursor, a caret) is cheap to encode twice, so it is always tried; it
        // takes no part in the guess, which is about the big areas where the time goes.
        let small = rect.2 * rect.3 <= SMALL_RECT;
        if self.p.try_opaque && !first && !is_local && (small || data.len() > 256) {
            let keep = idx.iter().filter(|&&i| i == ti).count();
            let runs = idx.windows(2).filter(|p| (p[0] == ti) != (p[1] == ti)).count();
            let keep_share = keep as f32 / idx.len() as f32;
            if small || self.opq.want(keep_share, runs as f32 / keep.max(1) as f32) {
                let (d2, i2) = encode_rect(&Ctx { opaque: true, ..ctx }, rect, bands);
                // lossless: painting unchanged pixels must not change what they show, which it
                // can when the palette lacks their exact colour
                let err = |ix: &[u8]| -> f64 {
                    let (x0, y0, rw, _) = rect;
                    ix.iter()
                        .enumerate()
                        .map(|(k, &i)| {
                            let q = (y0 + k / rw) * w + x0 + k % rw;
                            let shown = if i != ti {
                                &pal[i as usize]
                            } else if tclear.as_ref().is_some_and(|c| c[q]) {
                                return 0.0;
                            } else {
                                &self.canvas[q]
                            };
                            dist(&src[q], shown) as f64
                        })
                        .sum()
                };
                let won = d2.len() < data.len() && (!self.lossless() || err(&i2) <= err(&idx));
                if !small {
                    self.opq.report(keep_share, won, d2.len() as f32 / data.len() as f32);
                }
                if won {
                    (data, idx) = (d2, i2);
                    self.stats.opaque_frames += 1;
                }
            }
        }
        self.stats.pass2_s += now() - tt;
        let (x0, y0, rw, rh) = rect;
        for y in 0..rh {
            for x in 0..rw {
                let i = idx[y * rw + x];
                let q = (y0 + y) * w + x0 + x;
                if t.is_none() {
                    self.canvas[q] = pal[i as usize];
                    self.painted[q] = src[q];
                } else if i != ti && ((self.alpha && self.clear[q]) || pal[i as usize] != self.canvas[q]) {
                    self.canvas[q] = pal[i as usize];
                    self.painted[q] = src[q];
                    if self.alpha {
                        self.clear[q] = false;
                    }
                }
            }
        }
        self.dump_canvas()?;
        self.write_pending()?;
        self.pending = Some(Pending { rect, data, idx, lpal: if is_local { Some(pal) } else { None }, mcs, ti, delay, dispose_bg: false });
        Ok(())
    }

    /// Write the last frame and the trailer. Returns the writer and the statistics.
    pub fn finish(mut self) -> std::io::Result<(W, Stats)> {
        if self.stats.frames_in == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "no frames"));
        }
        self.write_pending()?;
        self.out.write_all(&[0x3B])?;
        self.stats.bytes += 1;
        self.out.flush()?;
        if let Some(d) = self.dump.as_mut() {
            d.flush()?;
        }
        Ok((self.out, self.stats))
    }
}

/// One quality knob (0..100) for people and for the size search. Anchors are settings measured
/// on the film benchmark (SSIMULACRA2 about 50 at 35 and 70 at 62); in between, interpolated.
pub fn params_for_quality(q: f32, base: &Params) -> Params {
    // The top end reaches lossless: 90 is about SSIMULACRA2 90, 95 about 95, 100 exact (with
    // the source's colours, when the pixels each frame changes fit a palette of their own).
    const A: [(f32, f32, f32); 10] = [
        (0.0, 2400.0, 2400.0),
        (20.0, 800.0, 800.0),
        (35.0, 400.0, 400.0),
        (50.0, 200.0, 260.0),
        (65.0, 60.0, 97.5),
        (75.0, 30.0, 97.5),
        (85.0, 15.0, 52.0),
        (90.0, 10.0, 40.0),
        (95.0, 3.0, 10.0),
        (100.0, 0.0, 0.0),
    ];
    let q = q.clamp(0.0, 100.0);
    let k = A.iter().rposition(|a| a.0 <= q).unwrap().min(A.len() - 2);
    let (a, b) = (A[k], A[k + 1]);
    let t = (q - a.0) / (b.0 - a.0);
    Params { lambda: a.1 + t * (b.1 - a.1), tbias: a.2 + t * (b.2 - a.2), ..base.clone() }
}

/// Finds the best quality (and, only if it must, a smaller size) that fits a byte budget.
/// The caller encodes whatever `next()` asks for and reports the size back:
///
/// ```ignore
/// let mut s = SizeSearch::new(budget);
/// while let Some(a) = s.next() { let gif = encode(a.quality, a.scale); s.report(a, gif.len()); }
/// let best = s.best(); // None only if nothing fit even at the smallest size tried
/// ```
pub struct SizeSearch {
    target: usize,
    tried: Vec<(Attempt, usize)>,
    scale: f32,
    pub max_attempts: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Attempt {
    pub quality: f32,
    pub scale: f32, // 1 = original size; frames are resized to scale * size before encoding
}

pub const MIN_QUALITY: f32 = 30.0;
const SHRINK_QUALITY: f32 = 55.0;
const DEFAULT_SLOPE: f64 = 0.014;
const MIN_SCALE: f32 = 0.1;

impl SizeSearch {
    pub fn new(target: usize) -> Self {
        SizeSearch { target, tried: vec![], scale: 1.0, max_attempts: 10 }
    }

    pub fn report(&mut self, a: Attempt, bytes: usize) {
        self.tried.push((a, bytes));
    }

    /// Highest-quality attempt that fit, preferring the largest scale.
    pub fn best(&self) -> Option<Attempt> {
        self.tried
            .iter()
            .filter(|(_, b)| *b <= self.target)
            .max_by(|x, y| (x.0.scale, x.0.quality).partial_cmp(&(y.0.scale, y.0.quality)).unwrap())
            .map(|x| x.0)
    }

    /// How bytes grow with frame scale: bytes ~ scale^k. Frame area (k = 2) is the first guess;
    /// once two sizes were tried, k is measured (flat graphics and line art grow closer to
    /// linearly, since resampling blurs their edges into more colours).
    fn scale_exponent(&self) -> f64 {
        let mut scales: Vec<f32> = vec![];
        for (a, _) in &self.tried {
            if !scales.contains(&a.scale) {
                scales.push(a.scale);
            }
        }
        if scales.len() < 2 {
            return 2.0;
        }
        // ln(bytes) at SHRINK_QUALITY for a scale, from its attempt nearest to that quality
        let at = |sc: f32| {
            let (a, b) = self
                .tried
                .iter()
                .filter(|(a, _)| a.scale == sc)
                .min_by(|x, y| (x.0.quality - SHRINK_QUALITY).abs().partial_cmp(&(y.0.quality - SHRINK_QUALITY).abs()).unwrap())
                .unwrap();
            (*b as f64).max(1.0).ln() + DEFAULT_SLOPE * (SHRINK_QUALITY - a.quality) as f64
        };
        let (s0, s1) = (scales[scales.len() - 2], scales[scales.len() - 1]);
        ((at(s0) - at(s1)) / ((s0 as f64).ln() - (s1 as f64).ln())).clamp(0.7, 2.5)
    }

    pub fn next(&mut self) -> Option<Attempt> {
        if self.tried.len() >= self.max_attempts {
            return None;
        }
        let mut here: Vec<(f32, usize)> = self.tried.iter().filter(|(a, _)| a.scale == self.scale).map(|(a, b)| (a.quality, *b)).collect();
        here.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let sc = self.scale;
        let at = move |q: f64| Some(Attempt { quality: (q as f32).clamp(MIN_QUALITY, 100.0).round(), scale: sc });
        if here.is_empty() {
            return at(if self.scale == 1.0 { 70.0 } else { SHRINK_QUALITY as f64 });
        }
        let target = self.target as f64;
        let ln = |b: usize| (b as f64).ln();
        // bytes fall roughly exponentially with quality: fit ln(bytes) = a + slope*q on what was
        // measured at this size (a typical slope when there's only one point)
        let slope = if here.len() >= 2 {
            let (a, b) = (here[0], here[here.len() - 1]);
            ((ln(b.1) - ln(a.1)) / (b.0 - a.0).max(1.0) as f64).max(0.004)
        } else {
            DEFAULT_SLOPE
        };
        let predict = |q: f64| {
            let near = here.iter().min_by(|a, b| (a.0 as f64 - q).abs().partial_cmp(&(b.0 as f64 - q).abs()).unwrap()).unwrap();
            (ln(near.1) + slope * (q - near.0 as f64)).exp()
        };
        // quality that should land at ~97% of the budget, starting from a measured point
        let aim = |p: (f32, usize), slope: f64| p.0 as f64 + ((target * 0.97).ln() - ln(p.1)) / slope;
        let fit = here.iter().filter(|e| e.1 <= self.target).max_by(|a, b| a.0.partial_cmp(&b.0).unwrap()).copied();
        let over = here.iter().filter(|e| e.1 > self.target).min_by(|a, b| a.0.partial_cmp(&b.0).unwrap()).copied();
        match (fit, over) {
            (Some(f), None) => {
                if f.0 >= 100.0 {
                    return None; // best quality fits
                }
                at(aim(f, slope).max(f.0 as f64 + 3.0)) // room to spare: try higher quality
            }
            (Some(f), Some(o)) => {
                if o.0 - f.0 <= 3.0 || (f.1 as f64) >= 0.9 * target {
                    return None; // close enough
                }
                let s = ((ln(o.1) - ln(f.1)) / (o.0 - f.0) as f64).max(1e-3);
                at(aim(f, s).clamp(f.0 as f64 + 1.0, o.0 as f64 - 1.0))
            }
            (None, Some(o)) => {
                // Shrink the frames once even the lowest quality can't fit (measured, or clearly
                // predicted). Aim for a middling quality at the new size rather than the floor:
                // a smaller clean GIF looks better than a bigger mushy one.
                if o.0 <= MIN_QUALITY || predict(MIN_QUALITY as f64) > target * 1.15 {
                    let est = predict(SHRINK_QUALITY as f64);
                    let k = self.scale_exponent();
                    if self.scale <= MIN_SCALE {
                        return None; // already the smallest size
                    }
                    // a predicted size below the floor still gets one try at the floor: the
                    // prediction is rough for flat graphics, which shrink far better than it says
                    let s = (self.scale * (((target * 0.95 / est).powf(1.0 / k)) as f32).min(0.95)).max(MIN_SCALE);
                    self.scale = (s * 100.0).floor() / 100.0;
                    return Some(Attempt { quality: SHRINK_QUALITY, scale: self.scale });
                }
                at(aim(o, slope).min(o.0 as f64 - 3.0))
            }
            (None, None) => None,
        }
    }
}
