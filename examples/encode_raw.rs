//! Encodes a raw RGBA clip with exactly the calls the WebAssembly build makes (`wasm/src/lib.rs`,
//! `web/lessgif.js`), so `web/test/identity.mjs` can check that both produce the same bytes.
//!
//! Input: "RGBA", then u32 LE width, height and frame count, then the frames (w*h*4 bytes each).
//! Usage: encode_raw <in.rgba> <out.gif> [--quality Q | --lambda L --tbias T] [--fps 15]

use lessgif::{Encoder, PaletteBuilder, Params, params_for_quality};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: encode_raw <in.rgba> <out.gif> [--quality Q | --lambda L --tbias T] [--fps 15]");
        std::process::exit(2);
    }
    let (mut fps, mut quality, mut lambda, mut tbias) = (15.0f64, None, 60.0f32, 150.0f32);
    for kv in args[3..].chunks(2) {
        let v: f64 = kv.get(1).and_then(|v| v.parse().ok()).expect("option needs a number");
        match kv[0].as_str() {
            "--fps" => fps = v,
            "--quality" => quality = Some(v as f32),
            "--lambda" => lambda = v as f32,
            "--tbias" => tbias = v as f32,
            o => panic!("unknown option {o}"),
        }
    }
    let raw = std::fs::read(&args[1]).expect("cannot read input");
    assert_eq!(&raw[..4], b"RGBA", "not a raw RGBA clip");
    let u = |o: usize| u32::from_le_bytes(raw[o..o + 4].try_into().unwrap()) as usize;
    let (w, h, n) = (u(4), u(8), u(12));
    let fsz = w * h * 4;
    assert_eq!(raw.len(), 16 + n * fsz, "file size doesn't match its header");
    let frames: Vec<&[u8]> = (0..n).map(|k| &raw[16 + k * fsz..16 + (k + 1) * fsz]).collect();

    // gz_new_quality(quality, 255, 0.75) or gz_new(255, lambda, tbias, 0.75, 40, 0, 0)
    let p = match quality {
        Some(q) => params_for_quality(q, &Params { threads: 1, ..Params::default() }),
        None => Params { lambda, tbias, threads: 1, ..Params::default() },
    };
    let mut pb = PaletteBuilder::new();
    for f in &frames {
        pb.add(f, w, h);
    }
    let pal = pb.palette_for(&p);
    let mut e = Encoder::new(Vec::new(), w, h, pal, p, pb.has_clear).unwrap();
    // delaysForFps in web/lessgif.js
    let cs = |i: usize| (i as f64 * 100.0 / fps).round() as u32;
    for (k, f) in frames.iter().enumerate() {
        e.push(f, cs(k + 1) - cs(k)).unwrap();
    }
    let (gif, _) = e.finish().unwrap();
    std::fs::write(&args[2], gif).expect("cannot write output");
}
