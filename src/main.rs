//! Command-line front end for the lessgif encoder: reads a video (via ffmpeg), a GIF, or a
//! folder of PNGs, and streams the frames through `lessgif::Encoder`.

use image::AnimationDecoder;
use lessgif::{Encoder, PaletteBuilder, Params, Rgb, SizeSearch, Stats, params_for_quality};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::process::{Child, ChildStdout, Command, Stdio};

/// Where frames come from. Frames are produced one at a time so memory stays O(one frame)
/// no matter how long the clip is.
enum Source {
    /// numbered PNGs (benchmark clips)
    Pngs(Vec<std::path::PathBuf>, usize),
    /// any video ffmpeg can read, decoded to a PAM stream (stand-in for the browser's decoder)
    Video(Child, BufReader<ChildStdout>),
    /// an existing GIF, composited frame by frame, keeping its own timing
    Gif(image::Frames<'static>),
}

struct Frame {
    w: usize,
    h: usize,
    rgba: Vec<u8>,
    delay: Option<u32>, // centiseconds, when the source has its own timing
}

impl Source {
    fn pngs(dir: &str) -> Source {
        let mut paths: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                let n = p.file_name().unwrap().to_string_lossy().to_string();
                n.ends_with(".png")
            })
            .collect();
        paths.sort();
        Source::Pngs(paths, 0)
    }

    /// `fps` resamples to a constant frame rate (handles variable-frame-rate phone video);
    /// `max_side` limits the longest side. ffmpeg also applies rotation metadata and squares
    /// non-square pixels, which phone footage frequently needs.
    fn video(path: &str, fps: f64, max_side: usize) -> Source {
        let vf = format!(
            "scale=iw*sar:ih,setsar=1,fps={fps},\
             scale='if(gte(iw,ih),min({m},iw),-1)':'if(gte(iw,ih),-1,min({m},ih))':flags=lanczos,format=rgb24,format=rgba",
            m = max_side
        );
        let mut child = Command::new("ffmpeg")
            .args(["-v", "error", "-nostdin", "-i", path, "-an", "-sn", "-vf", &vf, "-f", "image2pipe", "-c:v", "pam", "-"])
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap_or_else(|e| {
                eprintln!("error: reading video needs ffmpeg on the PATH ({e})");
                std::process::exit(1)
            });
        let out = BufReader::with_capacity(1 << 20, child.stdout.take().unwrap());
        Source::Video(child, out)
    }

    fn gif(path: &str) -> Source {
        let f = BufReader::new(std::fs::File::open(path).expect("cannot open input"));
        let dec = image::codecs::gif::GifDecoder::new(f).unwrap_or_else(|e| {
            eprintln!("error: couldn't read the GIF {path} ({e})");
            std::process::exit(1)
        });
        Source::Gif(dec.into_frames())
    }

    fn next(&mut self) -> Option<Frame> {
        match self {
            Source::Pngs(paths, i) => {
                let p = paths.get(*i)?;
                *i += 1;
                let img = image::open(p).unwrap().to_rgba8();
                Some(Frame { w: img.width() as usize, h: img.height() as usize, rgba: img.into_raw(), delay: None })
            }
            Source::Video(_, r) => read_pam(r),
            Source::Gif(frames) => {
                let f = match frames.next()? {
                    Ok(f) => f,
                    Err(e) => {
                        eprintln!("warning: the GIF is damaged after this point ({e}); using the frames that could be read");
                        return None;
                    }
                };
                let (n, d) = f.delay().numer_denom_ms();
                let mut cs = (n as f64 / d as f64 / 10.0).round() as u32;
                // browsers show 0 and 1 cs delays as 10 cs; keep what people actually saw
                if cs < 2 {
                    cs = 10;
                }
                let img = f.into_buffer();
                Some(Frame { w: img.width() as usize, h: img.height() as usize, rgba: img.into_raw(), delay: Some(cs) })
            }
        }
    }

    fn finish(self) -> Result<(), String> {
        if let Source::Video(mut child, _) = self {
            let st = child.wait().map_err(|e| e.to_string())?;
            if !st.success() {
                return Err(format!("ffmpeg exited with {st}"));
            }
        }
        Ok(())
    }
}

/// PAM ("P7") frame as written by ffmpeg's pam encoder: a text header ending in ENDHDR,
/// then width*height*depth bytes.
fn read_pam(r: &mut BufReader<ChildStdout>) -> Option<Frame> {
    let (mut w, mut h, mut depth) = (0usize, 0usize, 0usize);
    let mut line = String::new();
    r.read_line(&mut line).ok()?;
    if line.trim() != "P7" {
        return None;
    }
    loop {
        line.clear();
        if r.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let mut it = line.split_whitespace();
        match (it.next(), it.next()) {
            (Some("WIDTH"), Some(v)) => w = v.parse().ok()?,
            (Some("HEIGHT"), Some(v)) => h = v.parse().ok()?,
            (Some("DEPTH"), Some(v)) => depth = v.parse().ok()?,
            (Some("ENDHDR"), _) => break,
            _ => {}
        }
    }
    if depth != 4 {
        return None;
    }
    let mut rgba = vec![0u8; w * h * 4];
    r.read_exact(&mut rgba).ok()?;
    Some(Frame { w, h, rgba, delay: None })
}

struct Opts {
    input: String,
    out: String,
    fps: f64,
    max_side: usize,
    p: Params,
    max_size: Option<usize>,
    loop_set: bool, // --loop given; otherwise a GIF input keeps its own loop count
}

fn parse_args() -> Opts {
    let args: Vec<String> = std::env::args().collect();
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let usage = "\
usage: lessgif <input> <out.gif> [options]

<input> is a video (anything ffmpeg can read; ffmpeg must be installed), a GIF, or a folder of PNG
frames (encoded in name order).

options:
  --quality Q      0-100, higher is better and bigger. 100 is lossless when each frame fits in
                   255 colours. Without it: --lambda 60 --tbias 150, similar to quality 65
  --max-size N     find the best quality that fits N bytes (suffix k or M, e.g. 256k); shrinks the
                   frames only if even the lowest quality doesn't fit
  --fps F          frame rate for video and PNG input (default 15; GIF input keeps its timing)
  --max-side S     scale video so its longest side is at most S pixels (default 480)
  --colors N       palette size, at most 255 (default 255)
  --dither D       error diffusion strength 0-1 (default 0.75)
  --threads N      encode each frame in N horizontal bands in parallel (default: all cores)
  --loop L         forever (or 0), once, or a number of repeats after the first play (default:
                   forever, or what a GIF input has)
  --lambda L --tbias T
                   the two raw settings --quality sets: error allowed to extend an LZW string, and
                   error forgiven to keep the previous frame's pixel
  -h, --help       show this help
  -V, --version    show the version
";
    let mut o = Opts {
        input: String::new(),
        out: String::new(),
        fps: 15.0,
        max_side: 480,
        p: Params { threads, ..Params::default() },
        max_size: None,
        loop_set: false,
    };
    let mut quality: Option<f32> = None;
    let mut pos = vec![];
    let mut i = 1;
    while i < args.len() {
        let a = args[i].as_str();
        let mut val = || {
            i += 1;
            args.get(i).and_then(|v| v.parse::<f64>().ok()).unwrap_or_else(|| {
                eprintln!("{usage}");
                std::process::exit(2)
            })
        };
        match a {
            "-h" | "--help" => {
                print!("{usage}");
                std::process::exit(0)
            }
            "-V" | "--version" => {
                println!("lessgif {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0)
            }
            "--max-size" => {
                i += 1;
                let v = args.get(i).map(|s| s.to_ascii_lowercase()).unwrap_or_default();
                let (num, mul) = match v.chars().last() {
                    Some('k') => (&v[..v.len() - 1], 1024.0),
                    Some('m') => (&v[..v.len() - 1], 1024.0 * 1024.0),
                    _ => (v.as_str(), 1.0),
                };
                o.max_size = Some(num.parse::<f64>().map(|n| (n * mul) as usize).unwrap_or_else(|_| {
                    eprintln!("{usage}");
                    std::process::exit(2)
                }));
            }
            "--loop" => {
                i += 1;
                o.p.loop_count = match args.get(i).map(String::as_str) {
                    Some("forever") => Some(0),
                    Some("once") => None,
                    Some(n) if n.parse::<u16>().is_ok() => n.parse().ok(),
                    _ => {
                        eprintln!("{usage}");
                        std::process::exit(2)
                    }
                };
                o.loop_set = true;
            }
            "--quality" => quality = Some(val() as f32),
            "--fps" => o.fps = val(),
            "--max-side" => o.max_side = val() as usize,
            "--lambda" => o.p.lambda = val() as f32,
            "--tbias" => o.p.tbias = val() as f32,
            "--dither" => o.p.dither = val() as f32,
            "--colors" => o.p.colors = val() as usize,
            "--errclamp" => o.p.errclamp = val() as f32,
            "--threads" => o.p.threads = val() as usize,
            "--band-bytes" => o.p.band_bytes = val() as usize,
            "--local" => o.p.local = true,
            "--denoise" => o.p.gate = val() as f32,
            "--edge-lo" => o.p.edge_lo = val() as f32,
            "--edge-hi" => o.p.edge_hi = val() as f32,
            "--flat-exact" => {
                let v = val();
                o.p.flat_exact = v != 0.0;
                o.p.flat_exact_any = v >= 2.0;
            }
            "--canvas-bonus" => o.p.canvas_bonus = val() != 0.0,
            "--try-opaque" => o.p.try_opaque = val() != 0.0,
            "--palette-tol" => o.p.palette_tol = val() as f32,
            "--flat-tight" => o.p.flat_tight = val() as f32,
            "--compact" => o.p.compact = val() != 0.0,
            "--local-auto" => o.p.local_auto = val() != 0.0,
            "--mask" => o.p.mask = val() != 0.0,
            _ if a.starts_with("--") => {
                eprintln!("{usage}");
                std::process::exit(2)
            }
            _ => pos.push(a.to_string()),
        }
        i += 1;
    }
    if pos.len() != 2 {
        eprintln!("{usage}");
        std::process::exit(2)
    }
    if !std::path::Path::new(&pos[0]).exists() {
        eprintln!("error: {} not found", pos[0]);
        std::process::exit(1)
    }
    o.input = pos[0].clone();
    o.out = pos[1].clone();
    if let Some(q) = quality {
        o.p = params_for_quality(q, &o.p);
    }
    if !o.loop_set && is_gif(&o.input) {
        o.p.loop_count = gif_loop_count(&o.input);
    }
    o
}

fn is_gif(path: &str) -> bool {
    let mut magic = [0u8; 4];
    std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut magic)).is_ok() && &magic == b"GIF8"
}

/// The loop count a GIF stores (`None` when it has no NETSCAPE2.0/ANIMEXTS1.0 block, which
/// browsers play once). Unreadable files count as looping forever, the encoder's default.
fn gif_loop_count(path: &str) -> Option<u16> {
    let b = std::fs::read(path).unwrap_or_default();
    if b.len() < 13 {
        return Some(0);
    }
    let table = |flags: u8| if flags & 0x80 != 0 { 3 << ((flags & 7) + 1) } else { 0 };
    // skips data sub-blocks (a length byte, then that many bytes, until a zero length)
    let skip = |mut i: usize| {
        while i < b.len() && b[i] != 0 {
            i += b[i] as usize + 1;
        }
        i + 1
    };
    let mut i = 13 + table(b[10]);
    while i < b.len() {
        match b[i] {
            0x21 if i + 1 < b.len() => {
                let app = b.get(i + 2..i + 14);
                if b[i + 1] == 0xFF
                    && (app == Some(b"\x0bNETSCAPE2.0") || app == Some(b"\x0bANIMEXTS1.0"))
                    && let Some(&[3, 1, lo, hi]) = b.get(i + 14..i + 18)
                {
                    return Some(u16::from_le_bytes([lo, hi]));
                }
                i = skip(i + 2);
            }
            0x2C if i + 10 < b.len() => i = skip(i + 11 + table(b[i + 9])),
            _ => break,
        }
    }
    None
}

fn open_source(o: &Opts, fps: f64, max_side: usize) -> Source {
    if std::path::Path::new(&o.input).is_dir() {
        Source::pngs(&o.input)
    } else if is_gif(&o.input) {
        Source::gif(&o.input)
    } else {
        Source::video(&o.input, fps, max_side)
    }
}

/// Resize RGBA with premultiplied alpha, so transparent pixels don't bleed their (meaningless)
/// colour into the edges of what's visible.
fn resize_rgba(rgba: &[u8], w: usize, h: usize, nw: usize, nh: usize) -> Vec<u8> {
    let pre: Vec<u8> = rgba
        .as_chunks::<4>()
        .0
        .iter()
        .flat_map(|c| {
            let a = c[3] as u32;
            [(c[0] as u32 * a / 255) as u8, (c[1] as u32 * a / 255) as u8, (c[2] as u32 * a / 255) as u8, c[3]]
        })
        .collect();
    let img = image::RgbaImage::from_raw(w as u32, h as u32, pre).unwrap();
    let r = image::imageops::resize(&img, nw as u32, nh as u32, image::imageops::FilterType::Lanczos3);
    r.into_raw()
        .as_chunks::<4>()
        .0
        .iter()
        .flat_map(|c| {
            let a = c[3] as u32;
            if a == 0 {
                [0, 0, 0, 0]
            } else {
                let un = |v: u8| ((v as u32 * 255 + a / 2) / a).min(255) as u8;
                [un(c[0]), un(c[1]), un(c[2]), c[3]]
            }
        })
        .collect()
}

/// Frames at a given scale: videos are scaled by ffmpeg, GIFs and PNGs here.
struct Scaled {
    src: Source,
    scale: f32,
}
impl Scaled {
    fn open(o: &Opts, fps: f64, scale: f32, base_side: usize) -> Scaled {
        let side = if scale < 1.0 { ((base_side as f32 * scale).round() as usize).max(1) } else { o.max_side };
        Scaled { src: open_source(o, fps, side), scale }
    }
    fn next(&mut self) -> Option<Frame> {
        let mut f = self.src.next()?;
        if self.scale < 1.0 && !matches!(self.src, Source::Video(..)) {
            let (nw, nh) = (((f.w as f32 * self.scale).round() as usize).max(1), ((f.h as f32 * self.scale).round() as usize).max(1));
            f.rgba = resize_rgba(&f.rgba, f.w, f.h, nw, nh);
            (f.w, f.h) = (nw, nh);
        }
        Some(f)
    }
    fn finish(self) -> Result<(), String> {
        self.src.finish()
    }
}

/// Palette-pass result for one scale (it doesn't depend on quality, so the size search reuses it).
struct Analysis {
    pb: PaletteBuilder,
    alpha: bool,
    dims: (usize, usize),
}

impl Analysis {
    /// The palette depends on quality (it may shrink at lower quality), so it's built per encode.
    fn palette(&self, p: &Params) -> Vec<Rgb> {
        self.pb.palette_for(p)
    }
}

fn analyse(o: &Opts, scale: f32, base_side: usize) -> Analysis {
    // Stream the clip once (videos at a low frame rate) and keep a small random sample of pixels
    // from each frame. Memory: a few MB regardless of clip length. A clip shorter than one
    // palette-pass frame interval yields nothing at 3 fps; then sample it at the full frame rate.
    let mut src = Scaled::open(o, o.fps.min(3.0), scale, base_side);
    let mut first = src.next();
    if first.is_none() {
        let _ = src.finish();
        src = Scaled::open(o, o.fps, scale, base_side);
        first = src.next();
    }
    let mut pb = PaletteBuilder::new();
    while let Some(f) = first.take().or_else(|| src.next()) {
        pb.add(&f.rgba, f.w, f.h);
    }
    let status = src.finish();
    if pb.frames == 0 {
        eprintln!("error: couldn't read any video from {} (damaged file, unsupported format, or no video track)", o.input);
        std::process::exit(1);
    }
    if let Err(e) = status {
        eprintln!("warning: the video ended early or is partly damaged ({e}); using the frames that could be read");
    }
    Analysis { dims: pb.dims.unwrap(), alpha: pb.has_clear, pb }
}

/// The size search encodes the same frames several times, so it decodes them once per size.
fn load(o: &Opts, scale: f32, base_side: usize) -> (Vec<Frame>, Analysis) {
    let mut src = Scaled::open(o, o.fps, scale, base_side);
    let mut frames = vec![];
    while let Some(f) = src.next() {
        frames.push(f);
    }
    let _ = src.finish();
    let mut pb = PaletteBuilder::new();
    for f in &frames {
        pb.add(&f.rgba, f.w, f.h);
    }
    (frames, Analysis { alpha: pb.has_clear, dims: pb.dims.unwrap(), pb })
}

fn encode_frames(o: &Opts, p: &Params, an: &Analysis, frames: &[Frame]) -> (Vec<u8>, Stats) {
    let cs = |i: usize| (i as f64 * 100.0 / o.fps).round() as u32;
    let mut e = Encoder::new(Vec::new(), an.dims.0, an.dims.1, an.palette(p), p.clone(), an.alpha).unwrap();
    for (i, f) in frames.iter().enumerate() {
        e.push(&f.rgba, f.delay.unwrap_or_else(|| cs(i + 1) - cs(i))).unwrap();
    }
    e.finish().unwrap()
}

fn encode<W: Write>(o: &Opts, p: &Params, an: &Analysis, scale: f32, base_side: usize, out: W, dump: bool) -> (W, Stats, usize) {
    let mut src = Scaled::open(o, o.fps, scale, base_side);
    let cs = |i: usize| (i as f64 * 100.0 / o.fps).round() as u32;
    let (w, h) = an.dims;
    let mut e = Encoder::new(out, w, h, an.palette(p), p.clone(), an.alpha).unwrap_or_else(|e| {
        eprintln!("error: {e}");
        std::process::exit(1)
    });
    // Test oracle: LESSGIF_DUMP=<file> receives the exact picture each written frame is meant to
    // show, so tests can check real decoders reproduce it exactly.
    if dump && let Ok(f) = std::env::var("LESSGIF_DUMP") {
        e.dump = Some(Box::new(BufWriter::new(std::fs::File::create(f).unwrap())));
    }
    let mut fi = 0usize;
    while let Some(frame) = src.next() {
        if (frame.w, frame.h) != (w, h) {
            eprintln!("error: palette pass and encode pass disagree on frame size");
            std::process::exit(1);
        }
        let delay = frame.delay.unwrap_or_else(|| cs(fi + 1) - cs(fi));
        fi += 1;
        if let Err(err) = e.push(&frame.rgba, delay) {
            eprintln!("error: {err}");
            std::process::exit(1);
        }
    }
    if let Err(err) = src.finish() {
        eprintln!("warning: the video ended early or is partly damaged ({err}); used the frames that could be read");
    }
    if fi == 0 {
        eprintln!("error: couldn't read any video from {} (damaged file, unsupported format, or no video track)", o.input);
        std::process::exit(1);
    }
    let (w, st) = e.finish().expect("write failed");
    (w, st, fi)
}

fn main() {
    let mut o = parse_args();
    if o.fps > 50.0 {
        // GIF delays are whole centiseconds and browsers slow down anything under 2cs
        eprintln!("note: GIF can't play faster than 50 fps; using 50");
        o.fps = 50.0;
    }
    let t_start = std::time::Instant::now();
    let an = analyse(&o, 1.0, 0);
    let base_side = an.dims.0.max(an.dims.1);
    let t_pal = t_start.elapsed().as_secs_f64();

    let (st, fi, alpha, dims) = if let Some(budget) = o.max_size {
        // Size budget: search quality (and, only if even low quality is too big, frame size)
        let mut search = SizeSearch::new(budget);
        drop(an);
        let mut cur: Option<(f32, Vec<Frame>, Analysis)> = None;
        let mut best: Option<(lessgif::Attempt, Vec<u8>, Stats, usize, bool, (usize, usize))> = None;
        while let Some(a) = search.next() {
            if cur.as_ref().is_none_or(|c| c.0 != a.scale) {
                drop(cur.take()); // free the previous size's frames first
                let (fr, an) = load(&o, a.scale, base_side);
                cur = Some((a.scale, fr, an));
            }
            let (_, frames, an) = cur.as_ref().unwrap();
            let p = params_for_quality(a.quality, &o.p);
            let (gif, st) = encode_frames(&o, &p, an, frames);
            let fi = frames.len();
            eprintln!(
                "  quality {:>3} at {}x{}: {:.1} KB{}",
                a.quality,
                an.dims.0,
                an.dims.1,
                gif.len() as f64 / 1024.0,
                if gif.len() <= budget { "" } else { " (too big)" }
            );
            search.report(a, gif.len());
            if search.best() == Some(a) {
                best = Some((a, gif, st, fi, an.alpha, an.dims));
            }
        }
        let Some((a, gif, st, fi, alpha, dims)) = best else {
            eprintln!("error: couldn't get this under {:.1} KB even at a tiny size", budget as f64 / 1024.0);
            std::process::exit(1);
        };
        std::fs::write(&o.out, &gif).expect("cannot write output");
        eprintln!("chose quality {} at {}x{}", a.quality, dims.0, dims.1);
        (st, fi, alpha, dims)
    } else {
        let out = BufWriter::with_capacity(1 << 20, std::fs::File::create(&o.out).expect("cannot create output"));
        let (_, st, fi) = encode(&o, &o.p, &an, 1.0, base_side, out, true);
        (st, fi, an.alpha, an.dims)
    };
    eprintln!(
        "time: total {:.2}s palette-pass {t_pal:.2}s pass1 {:.2}s pass2 {:.2}s",
        t_start.elapsed().as_secs_f64(),
        st.pass1_s,
        st.pass2_s
    );
    let hwm = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("VmHWM")).map(|l| l.split_whitespace().nth(1).unwrap_or("0").to_string()))
        .and_then(|k| k.parse::<f64>().ok())
        .unwrap_or(0.0);
    if hwm > 0.0 {
        eprintln!("encoder peak memory {:.1} MB", hwm / 1024.0);
    }
    if st.own_palette_frames > 0 {
        eprintln!("{} frames got their own palette", st.own_palette_frames);
    }
    if st.compact_frames > 0 {
        eprintln!("{} frames used a smaller code size", st.compact_frames);
    }
    if st.opaque_frames > 0 {
        eprintln!("{} frames were smaller without transparency", st.opaque_frames);
    }
    eprintln!(
        "{fi} frames ({}x{}) -> {} written, {} bytes{}",
        dims.0,
        dims.1,
        st.frames_written,
        st.bytes,
        if alpha { ", with transparency" } else { "" }
    );
    let _ = std::io::stderr().flush();
}
