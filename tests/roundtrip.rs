//! End-to-end checks: encode synthetic clips, decode them with an independent GIF decoder
//! (the `image` crate) and compare with what the encoder says each frame should show.
//!
//! The encoder's `dump` hook writes the exact picture it intends every written frame to show.
//! Lossy settings change that picture, but never the fact that a decoder must reproduce it
//! pixel for pixel: any disagreement is a bug in the bitstream (LZW, transparency, disposal,
//! frame rectangles, palettes).

use image::AnimationDecoder;
use image::codecs::gif::GifDecoder;
use lessgif::{Encoder, PaletteBuilder, Params, SizeSearch, Stats, params_for_quality};
use std::io::{Cursor, Write};
use std::sync::{Arc, Mutex};

/// A `Write` the test can read back after the encoder (which owns the box) is done.
#[derive(Clone, Default)]
struct Shared(Arc<Mutex<Vec<u8>>>);
impl Write for Shared {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct Clip {
    name: &'static str,
    w: usize,
    h: usize,
    frames: Vec<Vec<u8>>, // RGBA
    delays: Vec<u32>,     // centiseconds
}

/// Small deterministic generator (no rand dependency).
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
    fn byte(&mut self) -> u8 {
        self.next() as u8
    }
}

fn clip(name: &'static str, w: usize, h: usize, n: usize, f: impl Fn(usize, usize, usize) -> [u8; 4]) -> Clip {
    let frames = (0..n).map(|i| (0..h).flat_map(|y| (0..w).map(move |x| (x, y))).flat_map(|(x, y)| f(i, x, y)).collect()).collect();
    // irregular delays, like a 15 fps clip rounded to centiseconds
    let delays = (0..n).map(|i| [7, 7, 6][i % 3]).collect();
    Clip { name, w, h, frames, delays }
}

/// Smooth moving gradient with sensor-like noise: more colours than a palette holds.
fn gradient(w: usize, h: usize, n: usize) -> Clip {
    clip("gradient", w, h, n, |i, x, y| {
        let mut r = Lcg((i * 1_000_003 + y * 1009 + x) as u64);
        let g = |v: f32| (v.clamp(0.0, 255.0)) as u8;
        let t = i as f32 * 3.0;
        let nz = (r.next() % 9) as f32 - 4.0;
        [
            g(x as f32 * 255.0 / w as f32 + t + nz),
            g(y as f32 * 255.0 / h as f32 + nz),
            g(128.0 + 100.0 * ((x + y) as f32 * 0.1 + t * 0.05).sin()),
            255,
        ]
    })
}

/// Pure noise: the worst case for LZW and for keeping pixels between frames.
fn noise(w: usize, h: usize, n: usize) -> Clip {
    clip("noise", w, h, n, |i, x, y| {
        let mut r = Lcg((i * 7919 + y * 104729 + x * 31) as u64);
        [r.byte(), r.byte(), r.byte(), 255]
    })
}

/// Flat colours and a moving box: exact palette colours, keeps and transparency.
fn cartoon(w: usize, h: usize, n: usize) -> Clip {
    const P: [[u8; 3]; 6] = [[250, 240, 200], [30, 30, 40], [200, 40, 40], [40, 160, 70], [50, 90, 220], [255, 255, 255]];
    clip("cartoon", w, h, n, |i, x, y| {
        let bx = (i * 3) % w.max(1);
        let c = if x >= bx && x < bx + w / 4 && y >= h / 3 && y < h / 3 + h / 4 {
            P[2 + i % 3]
        } else if (x / 8 + y / 8) % 2 == 0 {
            P[0]
        } else {
            P[5]
        };
        let c = if y == h / 2 { P[1] } else { c };
        [c[0], c[1], c[2], 255]
    })
}

/// Transparent background with a moving sprite, half-transparent edges, and one empty frame.
fn sprite(w: usize, h: usize, n: usize) -> Clip {
    clip("sprite", w, h, n, |i, x, y| {
        if i == n / 2 {
            return [0, 0, 0, 0];
        }
        let (cx, cy) = ((w as f32) * (0.3 + 0.05 * i as f32), h as f32 / 2.0);
        let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
        let r = w.min(h) as f32 / 4.0;
        if d < r {
            [(200.0 - d * 4.0) as u8, (60 + i * 10) as u8, 90, 255]
        } else if d < r + 1.5 {
            [255, 255, 0, 100 + (i as u8 % 2) * 60] // straddles the 128 transparency threshold
        } else {
            [0, 0, 0, 0]
        }
    })
}

/// A dark fade with a still background: exercises the keep logic in near-black frames.
fn fade(w: usize, h: usize, n: usize) -> Clip {
    clip("fade", w, h, n, |i, x, y| {
        let k = 1.0 - i as f32 / n as f32;
        let v = |c: f32| (c * k) as u8;
        [v(40.0 + (x / 4) as f32 * 8.0), v(30.0 + (y / 4) as f32 * 10.0), v(60.0), 255] // 64 colours a frame
    })
}

/// The same frame over and over: should collapse into one written frame with the summed delay.
fn still(w: usize, h: usize, n: usize) -> Clip {
    let mut c = clip("still", w, h, n, |_, x, y| [(x * 9) as u8, (y * 7) as u8, ((x ^ y) * 5) as u8, 255]);
    c.delays = vec![10; n];
    c
}

/// Colours that change by a single level between frames: "lossless" must not round them away.
fn subtle(w: usize, h: usize, n: usize) -> Clip {
    clip("subtle", w, h, n, |i, x, y| {
        // 225 colours a frame, 450 over the clip: more than one shared palette holds
        [100 + (x % 15) as u8 * 3, 150 + (y % 15) as u8 * 3, 200 + (i % 2) as u8, 255]
    })
}

fn all_clips() -> Vec<Clip> {
    let mut v = vec![
        gradient(64, 48, 10),
        noise(40, 30, 5),
        cartoon(50, 40, 9),
        sprite(48, 40, 8),
        fade(32, 32, 14),
        still(20, 12, 6),
        subtle(24, 16, 6),
    ];
    // sizes at the edges of what the bitstream handles: single pixel, single row/column, odd sizes
    for (w, h) in [(1, 1), (7, 3), (1, 33), (33, 1)] {
        let mut g = gradient(w, h, 4);
        g.name = "odd-size";
        v.push(g);
    }
    v
}

fn encode(c: &Clip, p: &Params) -> (Vec<u8>, Vec<u8>, Stats, bool) {
    let mut pb = PaletteBuilder::new();
    for f in &c.frames {
        pb.add(f, c.w, c.h);
    }
    let alpha = pb.has_clear;
    let pal = pb.palette_for(p);
    let dump = Shared::default();
    let mut e = Encoder::new(Vec::new(), c.w, c.h, pal, p.clone(), alpha).unwrap();
    e.dump = Some(Box::new(dump.clone()));
    for (f, &d) in c.frames.iter().zip(&c.delays) {
        e.push(f, d).unwrap();
    }
    let (gif, st) = e.finish().unwrap();
    let dumped = dump.0.lock().unwrap().clone();
    (gif, dumped, st, alpha)
}

/// Decoded frames as RGBA, with every transparent pixel normalised to 0,0,0,0, and delays in cs.
fn decode(gif: &[u8]) -> Vec<(Vec<u8>, u32)> {
    let dec = GifDecoder::new(Cursor::new(gif)).expect("output must be a readable GIF");
    dec.into_frames()
        .collect_frames()
        .expect("every frame must decode")
        .into_iter()
        .map(|f| {
            let (n, d) = f.delay().numer_denom_ms();
            let cs = (n as f64 / d as f64 / 10.0).round() as u32;
            let mut px = f.into_buffer().into_raw();
            for p in px.as_chunks_mut::<4>().0 {
                if p[3] == 0 {
                    p.copy_from_slice(&[0, 0, 0, 0]);
                }
            }
            (px, cs)
        })
        .collect()
}

/// The encoder's intended frames as RGBA (the dump is RGB without alpha).
fn intended(dump: &[u8], c: &Clip, alpha: bool) -> Vec<Vec<u8>> {
    let px = c.w * c.h;
    if alpha {
        dump.chunks_exact(px * 4).map(|f| f.to_vec()).collect()
    } else {
        dump.chunks_exact(px * 3).map(|f| f.as_chunks::<3>().0.iter().flat_map(|p| [p[0], p[1], p[2], 255]).collect()).collect()
    }
}

fn check_exact(c: &Clip, p: &Params, what: &str) -> Vec<u8> {
    let (gif, dump, st, alpha) = encode(c, p);
    let want = intended(&dump, c, alpha);
    let got = decode(&gif);
    let tag = format!("{} {}x{} {what}", c.name, c.w, c.h);
    assert_eq!(st.bytes, gif.len(), "{tag}: byte count in stats");
    assert_eq!(got.len(), st.frames_written, "{tag}: frames written");
    assert_eq!(want.len(), got.len(), "{tag}: frames intended vs decoded");
    for (k, ((g, _), w)) in got.iter().zip(&want).enumerate() {
        if g != w {
            let i = g.iter().zip(w).position(|(a, b)| a != b).unwrap() / 4;
            panic!(
                "{tag}: frame {k} pixel ({}, {}) decodes to {:?}, intended {:?}",
                i % c.w,
                i / c.w,
                &g[i * 4..i * 4 + 4],
                &w[i * 4..i * 4 + 4]
            );
        }
    }
    let total: u32 = got.iter().map(|f| f.1).sum();
    assert_eq!(total, c.delays.iter().sum::<u32>(), "{tag}: total duration");
    gif
}

#[test]
fn every_output_decodes_to_the_intended_frames() {
    for c in all_clips() {
        for q in [0.0, 30.0, 70.0, 90.0, 100.0] {
            for threads in [1, 3] {
                let p = params_for_quality(q, &Params { threads, band_bytes: 0, ..Params::default() });
                check_exact(&c, &p, &format!("quality {q} threads {threads}"));
            }
        }
    }
}

#[test]
fn other_settings_decode_exactly_too() {
    let variants: Vec<(&str, Params)> = vec![
        ("defaults", Params::default()),
        ("local palettes", Params { local: true, ..Params::default() }),
        ("16 colours", Params { colors: 16, ..Params::default() }),
        ("2 colours", Params { colors: 2, ..Params::default() }),
        ("no dither", Params { dither: 0.0, ..Params::default() }),
        ("full dither", Params { dither: 1.0, ..Params::default() }),
        ("no mask", Params { mask: false, ..Params::default() }),
        ("denoise", Params { gate: 30.0, ..Params::default() }),
        ("edge-aware", Params { edge_lo: 20.0, edge_hi: 60.0, ..Params::default() }),
        ("plain", Params { try_opaque: false, compact: false, local_auto: false, flat_exact: false, ..Params::default() }),
    ];
    for c in all_clips() {
        for (name, p) in &variants {
            check_exact(&c, p, name);
        }
    }
}

#[test]
fn quality_100_is_lossless_when_frames_fit_a_palette() {
    // cartoon, sprite, still, the dark fade and subtle have at most 255 colours per frame
    for c in [cartoon(50, 40, 9), sprite(48, 40, 8), still(20, 12, 6), fade(32, 32, 14), subtle(24, 16, 6)] {
        let p = params_for_quality(100.0, &Params::default());
        let gif = check_exact(&c, &p, "lossless");
        let got = decode(&gif);
        // compare against the source at every input frame's display time
        let mut t = 0;
        let starts: Vec<u32> = got
            .iter()
            .map(|f| {
                let s = t;
                t += f.1;
                s
            })
            .collect();
        let mut at = 0;
        for (src, d) in c.frames.iter().zip(&c.delays) {
            let k = starts.iter().rposition(|&s| s <= at).unwrap();
            for (i, (g, s)) in got[k].0.as_chunks::<4>().0.iter().zip(src.as_chunks::<4>().0).enumerate() {
                let want = if s[3] < 128 { [0, 0, 0, 0] } else { [s[0], s[1], s[2], 255] };
                assert_eq!(*g, want, "{}: pixel {i} at {at} cs", c.name);
            }
            at += d;
        }
    }
}

#[test]
fn output_is_deterministic() {
    for c in [gradient(64, 48, 10), sprite(48, 40, 8)] {
        for threads in [1, 4] {
            let p = Params { threads, band_bytes: 0, ..Params::default() };
            assert_eq!(encode(&c, &p).0, encode(&c, &p).0, "{} threads {threads}", c.name);
        }
    }
}

#[test]
fn lower_quality_is_smaller() {
    let c = gradient(64, 48, 10);
    let size = |q: f32| encode(&c, &params_for_quality(q, &Params::default())).0.len();
    let (lo, mid, hi) = (size(20.0), size(65.0), size(100.0));
    assert!(lo < mid && mid < hi, "sizes at quality 20/65/100: {lo} {mid} {hi}");
}

#[test]
fn size_search_fits_the_budget() {
    let c = gradient(96, 64, 12);
    let size = |q: f32| encode(&c, &params_for_quality(q, &Params::default())).0.len();
    // a budget between quality 50 and 80: no need to shrink the frames
    let budget = (size(50.0) + size(80.0)) / 2;
    let mut s = SizeSearch::new(budget);
    while let Some(a) = s.next() {
        assert_eq!(a.scale, 1.0, "this budget should not need smaller frames");
        s.report(a, size(a.quality));
    }
    let best = s.best().expect("something fits");
    assert!(size(best.quality) <= budget);
    assert!(best.quality > 50.0 && best.quality < 80.0, "chose quality {}", best.quality);
}

#[test]
fn loop_count_is_written_as_asked() {
    let c = sprite(24, 20, 4);
    for (lc, want) in [(Some(0), Some([0, 0])), (Some(3), Some([3, 0])), (Some(300), Some([44, 1])), (None, None)] {
        let gif = encode(&c, &Params { loop_count: lc, ..Params::default() }).0;
        let at = gif.windows(11).position(|w| w == b"NETSCAPE2.0");
        assert_eq!(at.map(|i| [gif[i + 13], gif[i + 14]]), want, "loop_count {lc:?}");
        assert_eq!(decode(&gif).len(), 4, "loop_count {lc:?} must still decode");
    }
}

#[test]
fn rejects_what_gif_cannot_hold() {
    assert!(Encoder::new(Vec::new(), 0, 10, vec![[0.0; 3]], Params::default(), false).is_err());
    assert!(Encoder::new(Vec::new(), 70000, 10, vec![[0.0; 3]], Params::default(), false).is_err());
    let e = Encoder::new(Vec::new(), 4, 4, vec![[0.0; 3]], Params::default(), false).unwrap();
    assert!(e.finish().is_err(), "a GIF with no frames is an error");
}
