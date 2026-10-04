//! Hand-written C ABI over `lessgif` for wasm32-unknown-unknown (no wasm-bindgen).
//!
//! JS usage (see web/lessgif.js):
//!   s = gz_new_quality(quality, colors, dither)   or   gz_new(colors, lambda, tbias, dither, errclamp, gate, local)
//!   optionally gz_set_loop(s, n): n repeats, 0 forever (the default), -1 play once
//!   buf = gz_alloc(w*h*4)
//!   for each frame: copy RGBA into memory at buf; gz_pal_add(s, buf, w, h)
//!   gz_pal_build(s)
//!   gz_enc_new(s, w, h)
//!   for each frame: copy RGBA into buf; gz_enc_push(s, buf, delay_cs)
//!   n = gz_enc_finish(s); bytes = memory[gz_out_ptr(s) .. + n]
//!   gz_free(buf, w*h*4); gz_destroy(s)
//! Functions returning i32 use -1 for an error; the message is at gz_err_ptr/gz_err_len.
//!
//! Size budget (the CLI's --max-size): q = gz_search_new(bytes); while gz_search_next(q) is 1,
//! encode at gz_search_quality(q) with frames scaled by gz_search_scale(q), then
//! gz_search_report(q, gif_bytes). gz_search_best(q) is 1 if some attempt fit; it leaves that
//! attempt in gz_search_quality/gz_search_scale. gz_search_destroy(q) at the end.
//! A Rust panic traps (panic = "abort"); its message is kept at gz_panic_ptr/gz_panic_len.

use lessgif::{Attempt, Encoder, PaletteBuilder, Params, Rgb, SizeSearch, params_for_quality};
use std::sync::Mutex;

pub struct Session {
    p: Params,
    pb: Option<PaletteBuilder>,
    pal: Option<Vec<Rgb>>,
    alpha: bool,
    dims: Option<(usize, usize)>,
    enc: Option<Encoder<Vec<u8>>>,
    out: Vec<u8>,
    frames_written: usize,
    err: String,
}

static PANIC_MSG: Mutex<String> = Mutex::new(String::new());
static PANIC_COPY: Mutex<Vec<u8>> = Mutex::new(Vec::new());

fn install_panic_hook() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            if let Ok(mut m) = PANIC_MSG.try_lock() {
                *m = info.to_string();
            }
        }))
    });
}

impl Session {
    fn fail(&mut self, msg: impl Into<String>) -> i32 {
        self.err = msg.into();
        -1
    }
}

/// Allocate `n` bytes in wasm memory (for frame buffers). Free with `gz_free(p, n)`.
#[unsafe(no_mangle)]
pub extern "C" fn gz_alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `p` must come from `gz_alloc(n)` with the same `n`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gz_free(p: *mut u8, n: usize) {
    if !p.is_null() {
        unsafe { drop(Vec::from_raw_parts(p, 0, n)) };
    }
}

/// New encoding session with raw settings. `threads` is always 1 (wasm32-unknown-unknown has
/// no threads).
#[unsafe(no_mangle)]
pub extern "C" fn gz_new(colors: u32, lambda: f32, tbias: f32, dither: f32, errclamp: f32, gate: f32, local: u32) -> *mut Session {
    session(Params { colors: colors as usize, lambda, tbias, dither, errclamp, gate, local: local != 0, threads: 1, ..Params::default() })
}

/// New encoding session from the 0-100 quality knob (the CLI's `--quality`).
#[unsafe(no_mangle)]
pub extern "C" fn gz_new_quality(quality: f32, colors: u32, dither: f32) -> *mut Session {
    let base = Params { colors: colors as usize, dither, threads: 1, ..Params::default() };
    session(params_for_quality(quality, &base))
}

fn session(p: Params) -> *mut Session {
    install_panic_hook();
    Box::into_raw(Box::new(Session {
        p,
        pb: Some(PaletteBuilder::new()),
        pal: None,
        alpha: false,
        dims: None,
        enc: None,
        out: Vec::new(),
        frames_written: 0,
        err: String::new(),
    }))
}

/// Loop count for the GIF: `n` repeats, 0 forever (the default), negative for none (play once).
/// Call before `gz_enc_new`.
///
/// # Safety
/// `s` from `gz_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gz_set_loop(s: *mut Session, n: i32) {
    unsafe { (&mut *s).p.loop_count = if n < 0 { None } else { Some(n.min(65535) as u16) } };
}

/// # Safety
/// `s` from `gz_new`, not used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gz_destroy(s: *mut Session) {
    if !s.is_null() {
        unsafe { drop(Box::from_raw(s)) };
    }
}

/// Palette pass: feed one RGBA frame (w*h*4 bytes at `rgba`).
///
/// # Safety
/// `s` from `gz_new`; `rgba` points to w*h*4 readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gz_pal_add(s: *mut Session, rgba: *const u8, w: u32, h: u32) -> i32 {
    let s = unsafe { &mut *s };
    let (w, h) = (w as usize, h as usize);
    if w == 0 || h == 0 {
        return s.fail("empty frame");
    }
    if *s.dims.get_or_insert((w, h)) != (w, h) {
        return s.fail("frame size changed during the palette pass");
    }
    let Some(pb) = s.pb.as_mut() else {
        return s.fail("palette already built");
    };
    let data = unsafe { std::slice::from_raw_parts(rgba, w * h * 4) };
    pb.add(data, w, h);
    0
}

/// Build the global palette from what `gz_pal_add` saw. Returns the number of colours.
///
/// # Safety
/// `s` from `gz_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gz_pal_build(s: *mut Session) -> i32 {
    let s = unsafe { &mut *s };
    let Some(pb) = s.pb.take() else {
        return s.fail("palette already built");
    };
    if pb.frames == 0 {
        return s.fail("no frames were added to the palette pass");
    }
    s.alpha = pb.has_clear;
    let pal = pb.palette_for(&s.p);
    let n = pal.len() as i32;
    s.pal = Some(pal);
    n
}

/// 1 if the palette pass saw transparent pixels (the output will keep them transparent).
///
/// # Safety
/// `s` from `gz_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gz_has_alpha(s: *mut Session) -> u32 {
    unsafe { (&*s).alpha as u32 }
}

/// Start the encoder (after `gz_pal_build`). Writes the GIF header into the output buffer.
///
/// # Safety
/// `s` from `gz_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gz_enc_new(s: *mut Session, w: u32, h: u32) -> i32 {
    let s = unsafe { &mut *s };
    let (w, h) = (w as usize, h as usize);
    if let Some(d) = s.dims
        && d != (w, h)
    {
        return s.fail("palette pass and encode pass disagree on frame size");
    }
    let Some(pal) = s.pal.take() else {
        return s.fail("call gz_pal_build first");
    };
    match Encoder::new(Vec::<u8>::new(), w, h, pal, s.p.clone(), s.alpha) {
        Ok(e) => {
            s.enc = Some(e);
            s.dims = Some((w, h));
            0
        }
        Err(e) => s.fail(e.to_string()),
    }
}

/// Encode one RGBA frame shown for `delay` centiseconds.
///
/// # Safety
/// `s` from `gz_new`; `rgba` points to w*h*4 readable bytes (w, h as given to gz_enc_new).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gz_enc_push(s: *mut Session, rgba: *const u8, delay: u32) -> i32 {
    let s = unsafe { &mut *s };
    let Some((w, h)) = s.dims else {
        return s.fail("call gz_enc_new first");
    };
    let Some(enc) = s.enc.as_mut() else {
        return s.fail("call gz_enc_new first");
    };
    let data = unsafe { std::slice::from_raw_parts(rgba, w * h * 4) };
    match enc.push(data, delay) {
        Ok(()) => 0,
        Err(e) => s.fail(e.to_string()),
    }
}

/// Finish the GIF. Returns its length in bytes; the bytes are at `gz_out_ptr(s)`.
///
/// # Safety
/// `s` from `gz_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gz_enc_finish(s: *mut Session) -> i32 {
    let s = unsafe { &mut *s };
    let Some(enc) = s.enc.take() else {
        return s.fail("call gz_enc_new first");
    };
    match enc.finish() {
        Ok((out, st)) => {
            s.out = out;
            s.frames_written = st.frames_written;
            s.out.len() as i32
        }
        Err(e) => s.fail(e.to_string()),
    }
}

/// # Safety
/// `s` from `gz_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gz_out_ptr(s: *mut Session) -> *const u8 {
    unsafe { (&*s).out.as_ptr() }
}

/// # Safety
/// `s` from `gz_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gz_out_len(s: *mut Session) -> usize {
    unsafe { (&*s).out.len() }
}

/// Number of GIF frames written (still stretches are merged into one frame).
///
/// # Safety
/// `s` from `gz_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gz_frames_written(s: *mut Session) -> u32 {
    unsafe { (&*s).frames_written as u32 }
}

/// # Safety
/// `s` from `gz_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gz_err_ptr(s: *mut Session) -> *const u8 {
    unsafe { (&*s).err.as_ptr() }
}

/// # Safety
/// `s` from `gz_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gz_err_len(s: *mut Session) -> usize {
    unsafe { (&*s).err.len() }
}

/// Message of the last panic (after a `RuntimeError: unreachable` trap). Pointer stays valid
/// until the next call to this function.
#[unsafe(no_mangle)]
pub extern "C" fn gz_panic_ptr() -> *const u8 {
    let msg = PANIC_MSG.try_lock().map(|m| m.clone()).unwrap_or_default();
    let mut c = PANIC_COPY.lock().unwrap_or_else(|e| e.into_inner());
    *c = msg.into_bytes();
    c.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn gz_panic_len() -> usize {
    PANIC_COPY.lock().map(|c| c.len()).unwrap_or(0)
}

/// A size search and the attempt it last proposed (or, after `gz_search_best`, the best one).
pub struct Search {
    s: SizeSearch,
    cur: Attempt,
}

#[unsafe(no_mangle)]
pub extern "C" fn gz_search_new(target_bytes: u32) -> *mut Search {
    Box::into_raw(Box::new(Search { s: SizeSearch::new(target_bytes as usize), cur: Attempt { quality: 70.0, scale: 1.0 } }))
}

/// # Safety
/// `q` from `gz_search_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gz_search_next(q: *mut Search) -> u32 {
    let q = unsafe { &mut *q };
    match q.s.next() {
        Some(a) => {
            q.cur = a;
            1
        }
        None => 0,
    }
}

/// # Safety
/// `q` from `gz_search_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gz_search_quality(q: *mut Search) -> f32 {
    unsafe { (&*q).cur.quality }
}

/// Frame scale for the current attempt: 1 is the original size.
///
/// # Safety
/// `q` from `gz_search_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gz_search_scale(q: *mut Search) -> f32 {
    unsafe { (&*q).cur.scale }
}

/// Size in bytes of the GIF encoded for the current attempt.
///
/// # Safety
/// `q` from `gz_search_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gz_search_report(q: *mut Search, bytes: u32) {
    let q = unsafe { &mut *q };
    q.s.report(q.cur, bytes as usize);
}

/// # Safety
/// `q` from `gz_search_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gz_search_best(q: *mut Search) -> u32 {
    let q = unsafe { &mut *q };
    match q.s.best() {
        Some(a) => {
            q.cur = a;
            1
        }
        None => 0,
    }
}

/// # Safety
/// `q` from `gz_search_new`, not used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gz_search_destroy(q: *mut Search) {
    if !q.is_null() {
        unsafe { drop(Box::from_raw(q)) };
    }
}
