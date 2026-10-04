"""Generate hand-made edge-case GIFs for the decoder conformance harness.

usage: python3 make_edge.py   (writes edge/, random/, trunc/ next to this script)
Every file is built byte by byte with gifwriter.py so each oddity is deliberate.
"""
import os
import random
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from gifwriter import Gif, lzw, lzw_codes, pack_codes, subblocks, interlace_order, color_table  # noqa: E402

EDGE = os.path.join(HERE, 'edge')
RAND = os.path.join(HERE, 'random')
TRUNC = os.path.join(HERE, 'trunc')
for d in (EDGE, RAND, TRUNC):
    os.makedirs(d, exist_ok=True)
    for f in os.listdir(d):
        if f.endswith('.gif'):
            os.remove(os.path.join(d, f))

PAL4 = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0)]
PAL8 = PAL4 + [(255, 0, 255), (0, 255, 255), (128, 128, 128), (255, 255, 255)]
PAL16 = [(i * 16, 255 - i * 16, (i * 37) % 256) for i in range(16)]
PAL256 = [((i * 7) % 256, (i * 13) % 256, (i * 29) % 256) for i in range(256)]

count = 0


def save(g, name, d=EDGE):
    global count
    data = g.bytes() if isinstance(g, Gif) else g
    with open(os.path.join(d, name + '.gif'), 'wb') as f:
        f.write(data)
    count += 1
    return data


def px(w, h, f):
    return [f(x, y) for y in range(h) for x in range(w)]


def checker(w, h, a, b, s=1):
    return px(w, h, lambda x, y: a if ((x // s + y // s) % 2) else b)


def grad(w, h, n):
    return px(w, h, lambda x, y: (x + 2 * y) % n)


# ------------------------------------------------------------------ disposal / canvas
def disposal_cases():
    for d in range(8):
        g = Gif(12, 10, PAL8, bg=3).loop(0)
        g.gce(disposal=d, delay=5).image(0, 0, 12, 10, grad(12, 10, 8))
        g.gce(disposal=d, delay=5, trans=0).image(2, 2, 6, 5, checker(6, 5, 0, 5))
        g.gce(disposal=d, delay=5, trans=7).image(4, 1, 7, 7, checker(7, 7, 7, 1, 2))
        g.gce(disposal=0, delay=5, trans=2).image(1, 3, 9, 4, checker(9, 4, 2, 4))
        g.gce(disposal=0, delay=5).image(5, 5, 3, 3, [6] * 9)
        save(g.trailer(), f'disp_raw{d}')
    # disposal 3 on the first frame, then transparent partial frames
    g = Gif(10, 10, PAL8).loop(0)
    g.gce(disposal=3, delay=10).image(0, 0, 10, 10, grad(10, 10, 8))
    g.gce(disposal=1, delay=10, trans=0).image(3, 3, 4, 4, checker(4, 4, 0, 2))
    g.gce(disposal=3, delay=10, trans=0).image(0, 0, 5, 5, checker(5, 5, 0, 4))
    g.gce(disposal=0, delay=10, trans=0).image(5, 5, 5, 5, checker(5, 5, 0, 5))
    save(g.trailer(), 'disp3_first')
    # disposal 3 on the first frame, partial first frame
    g = Gif(10, 10, PAL8)
    g.gce(disposal=3, delay=10).image(2, 2, 5, 5, [1] * 25)
    g.gce(disposal=0, delay=10, trans=0).image(0, 0, 10, 10, checker(10, 10, 0, 3))
    save(g.trailer(), 'disp3_first_partial')
    # consecutive disposal-3 frames
    g = Gif(10, 8, PAL8).loop(0)
    g.gce(disposal=1, delay=10).image(0, 0, 10, 8, grad(10, 8, 8))
    for k in range(4):
        g.gce(disposal=3, delay=10, trans=0).image(k * 2, k, 4, 4, checker(4, 4, 0, k + 1))
    g.gce(disposal=0, delay=10, trans=0).image(1, 1, 8, 6, checker(8, 6, 0, 6))
    g.gce(disposal=3, delay=10).image(0, 0, 10, 8, [7] * 80)
    g.gce(disposal=3, delay=10, trans=0).image(2, 2, 3, 3, checker(3, 3, 0, 5))
    g.gce(disposal=0, delay=10, trans=0).image(4, 4, 3, 3, checker(3, 3, 0, 2))
    save(g.trailer(), 'disp3_consecutive')
    # all frames disposal 3
    g = Gif(8, 8, PAL8)
    for k in range(5):
        g.gce(disposal=3, delay=10, trans=0 if k % 2 else None).image(k, k, 4, 4, checker(4, 4, 0, k + 1))
    save(g.trailer(), 'disp3_all')
    # disposal 2 covering the full canvas, then transparent frames
    g = Gif(8, 8, PAL8)
    g.gce(disposal=2, delay=10).image(0, 0, 8, 8, grad(8, 8, 8))
    g.gce(disposal=2, delay=10, trans=0).image(0, 0, 8, 8, checker(8, 8, 0, 3))
    g.gce(disposal=0, delay=10, trans=0).image(2, 2, 4, 4, checker(4, 4, 0, 5))
    save(g.trailer(), 'disp2_full')
    # disposal 2 partly and wholly off-screen
    g = Gif(10, 10, PAL8)
    g.gce(disposal=0, delay=10).image(0, 0, 10, 10, grad(10, 10, 8))
    g.gce(disposal=2, delay=10, trans=0).image(6, 6, 8, 8, checker(8, 8, 0, 5))
    g.gce(disposal=2, delay=10).image(30, 30, 4, 4, [6] * 16)
    g.gce(disposal=0, delay=10, trans=0).image(0, 0, 5, 5, checker(5, 5, 0, 2))
    g.gce(disposal=2, delay=10).image(12, 0, 3, 3, [1] * 9)
    g.gce(disposal=0, delay=10).image(1, 1, 3, 3, [3] * 9)
    g.gce(disposal=0, delay=10, trans=4).image(0, 0, 10, 10, checker(10, 10, 4, 7))
    save(g.trailer(), 'disp2_offscreen')
    # opaque frames covering earlier rects (Skia "contains" shortcut) + disposal 2
    g = Gif(12, 12, PAL8)
    g.gce(disposal=1, delay=10).image(0, 0, 12, 12, grad(12, 12, 8))
    g.gce(disposal=2, delay=10).image(2, 2, 4, 4, [4] * 16)
    g.gce(disposal=1, delay=10).image(1, 1, 6, 6, [5] * 36)
    g.gce(disposal=2, delay=10).image(0, 0, 8, 8, checker(8, 8, 1, 2))
    g.gce(disposal=0, delay=10).image(0, 0, 9, 9, checker(9, 9, 3, 6))
    g.gce(disposal=0, delay=10, trans=6).image(0, 0, 12, 12, checker(12, 12, 6, 0, 3))
    save(g.trailer(), 'contains_chain')
    # background colour index pointing at a colour: browsers ignore it
    g = Gif(10, 10, PAL8, bg=4)
    g.gce(delay=10, disposal=2).image(2, 2, 4, 4, [1] * 16)
    g.gce(delay=10).image(5, 5, 3, 3, [2] * 9)
    save(g.trailer(), 'bg_index_ignored')
    # opaque full-canvas frame after transparent frames
    g = Gif(6, 6, PAL8)
    g.gce(delay=10, trans=0).image(0, 0, 6, 6, checker(6, 6, 0, 1))
    g.gce(delay=10).image(0, 0, 6, 6, grad(6, 6, 8))
    g.gce(delay=10, trans=3).image(1, 1, 4, 4, checker(4, 4, 3, 5))
    save(g.trailer(), 'opaque_full_after_trans')


# ------------------------------------------------------------------ transparency
def transparency_cases():
    for t in (0, 3, 7, 8, 200, 255):
        g = Gif(8, 6, PAL8)
        g.gce(delay=10).image(0, 0, 8, 6, grad(8, 6, 8))
        g.gce(delay=10, trans=t).image(0, 0, 8, 6, px(8, 6, lambda x, y: t if (x + y) % 3 == 0 else (x % 8)), mcs=8)
        g.gce(delay=10, trans=t, disposal=2).image(2, 1, 4, 4, px(4, 4, lambda x, y: t if x == y else 2), mcs=8)
        g.gce(delay=10).image(0, 0, 2, 2, [1, 2, 3, 4])
        save(g.trailer(), f'trans_index_{t}')
    # transparent first frame, unused transparent index
    g = Gif(6, 6, PAL4)
    g.gce(delay=10, trans=3).image(0, 0, 6, 6, checker(6, 6, 3, 1))
    g.gce(delay=10, trans=2).image(1, 1, 4, 4, checker(4, 4, 0, 1))
    save(g.trailer(), 'trans_first_frame')
    # transparency flag set in the GCE but index beyond the palette
    g = Gif(6, 6, PAL4, gct_bits=1)
    g.gce(delay=10).image(0, 0, 6, 6, grad(6, 6, 4))
    g.gce(delay=10, trans=9).image(0, 0, 6, 6, px(6, 6, lambda x, y: 9 if y < 3 else 1), mcs=4)
    save(g.trailer(), 'trans_beyond_palette')


# ------------------------------------------------------------------ interlace
def interlace_cases():
    for h in list(range(1, 18)) + [23, 31, 40]:
        g = Gif(5, h, PAL16)
        g.gce(delay=10).image(0, 0, 5, h, px(5, h, lambda x, y: (y + x) % 16), interlace=True)
        g.gce(delay=10, trans=0).image(1, 0, 3, h, px(3, h, lambda x, y: 0 if (x + y) % 2 else (y * 3) % 16), interlace=True)
        save(g.trailer(), f'interlace_h{h}')
    # interlaced first frame cut short by an early end code (Chrome then shows the partial frame,
    # with Wuffs' row replication of the first passes); a second frame keeps the file valid.
    for h in (5, 9, 16, 21, 33):
        idx = px(6, h, lambda x, y: (y * 5 + x) % 16)
        seq = interlace_order(idx, 6, h)
        for cut in sorted(set([1, 5, 6, 7, 6 * ((h + 7) // 8), 6 * ((h + 7) // 8) + 3, len(seq) // 2, len(seq) - 1])):
            if cut >= len(seq) or cut <= 0:
                continue
            for trans in (None, 15):
                g = Gif(6, h, PAL16)
                g.gce(delay=10, trans=trans).image(0, 0, 6, h, lzw_data=lzw(seq[:cut], 4), mcs=4, interlace=True)
                g.gce(delay=10).image(0, 0, 6, h, [2] * (6 * h))
                save(g.trailer(), f'interlace_partial_h{h}_cut{cut}' + ('_t' if trans is not None else ''))
    # interlaced first frame smaller than the logical screen, cut short
    idx = px(4, 12, lambda x, y: (y + 1) % 16)
    seq = interlace_order(idx, 4, 12)
    g = Gif(10, 16, PAL16)
    g.gce(delay=10).image(3, 2, 4, 12, lzw_data=lzw(seq[:9], 4), mcs=4, interlace=True)
    g.gce(delay=10).image(0, 0, 10, 16, [3] * 160)
    save(g.trailer(), 'interlace_partial_offset')
    # interlaced later frame cut short (no replication there)
    g = Gif(6, 10, PAL16)
    g.gce(delay=10).image(0, 0, 6, 10, [1] * 60)
    g.gce(delay=10).image(0, 0, 6, 10, lzw_data=lzw(interlace_order(px(6, 10, lambda x, y: y), 6, 10)[:20], 4), mcs=4, interlace=True)
    g.gce(delay=10).image(0, 0, 6, 10, [2] * 60)
    save(g.trailer(), 'interlace_partial_frame1')


# ------------------------------------------------------------------ colour tables
def palette_cases():
    # local only, global only, both
    g = Gif(6, 6)
    g.gce(delay=10).image(0, 0, 6, 6, grad(6, 6, 4), lct=PAL4)
    g.gce(delay=10).image(1, 1, 4, 4, grad(4, 4, 8), lct=PAL8)
    save(g.trailer(), 'local_only')
    g = Gif(6, 6, PAL8)
    g.gce(delay=10).image(0, 0, 6, 6, grad(6, 6, 8))
    g.gce(delay=10).image(1, 1, 4, 4, grad(4, 4, 4), lct=[(9, 9, 9), (99, 99, 99), (199, 199, 199), (250, 1, 2)])
    g.gce(delay=10).image(2, 2, 3, 3, grad(3, 3, 8))
    save(g.trailer(), 'local_and_global')
    # no colour table anywhere (Chrome draws black), with and without transparency
    g = Gif(6, 6)
    g.gce(delay=10).image(0, 0, 6, 6, grad(6, 6, 4))
    g.gce(delay=10, trans=1).image(1, 1, 4, 4, grad(4, 4, 4))
    save(g.trailer(), 'no_palette')
    g = Gif(6, 6, PAL4)
    g.gce(delay=10).image(0, 0, 6, 6, grad(6, 6, 4))
    g.gce(delay=10).image(1, 1, 4, 4, grad(4, 4, 4), lct=PAL8, flags=0x00)  # flag says no LCT: table bytes become garbage
    save(Gif(6, 6).gce(delay=10).image(0, 0, 6, 6, grad(6, 6, 4)).trailer(), 'no_palette_single')
    # table sizes 2..256 with indices beyond the table
    for bits in range(8):
        n = 2 << bits
        pal = PAL256[:n]
        g = Gif(16, 16, pal, gct_bits=bits)
        g.gce(delay=10).image(0, 0, 16, 16, px(16, 16, lambda x, y: (x * 16 + y) % 256), mcs=8)
        g.gce(delay=10).image(2, 2, 8, 8, px(8, 8, lambda x, y: (x * 31 + y * 7) % 256), mcs=8, lct=PAL256[:max(2, n // 2)], lct_bits=max(0, bits - 1))
        save(g.trailer(), f'palette_size_{n}')
    # global table flag set with size bits but a local table on frame 0 that is smaller
    g = Gif(4, 4, PAL256)
    g.gce(delay=10).image(0, 0, 4, 4, list(range(16)), mcs=4, lct=PAL4)
    save(g.trailer(), 'local_smaller_than_indices')


# ------------------------------------------------------------------ geometry
def geometry_cases():
    # partly outside right/bottom, wholly outside
    g = Gif(10, 8, PAL8)
    g.gce(delay=10).image(0, 0, 10, 8, grad(10, 8, 8))
    g.gce(delay=10).image(7, 5, 6, 6, [4] * 36)
    g.gce(delay=10, trans=0).image(8, 0, 5, 3, checker(5, 3, 0, 5))
    g.gce(delay=10).image(10, 0, 3, 3, [6] * 9)
    g.gce(delay=10).image(0, 8, 3, 3, [6] * 9)
    g.gce(delay=10).image(500, 500, 3, 3, [6] * 9)
    g.gce(delay=10, disposal=2).image(9, 7, 4, 4, [1] * 16)
    g.gce(delay=10).image(0, 0, 2, 2, [7] * 4)
    save(g.trailer(), 'outside_canvas')
    # first frame bigger than the logical screen
    g = Gif(6, 4, PAL8)
    g.gce(delay=10).image(0, 0, 9, 7, grad(9, 7, 8))
    g.gce(delay=10).image(6, 4, 5, 5, [3] * 25)
    save(g.trailer(), 'frame0_bigger_than_screen')
    g = Gif(6, 4, PAL8)
    g.gce(delay=10).image(4, 3, 5, 5, grad(5, 5, 8))
    g.gce(delay=10, trans=0).image(0, 0, 9, 8, checker(9, 8, 0, 6))
    save(g.trailer(), 'frame0_offset_beyond_screen')
    # logical screen 0x0
    g = Gif(0, 0, PAL8)
    g.gce(delay=10).image(0, 0, 7, 5, grad(7, 5, 8))
    g.gce(delay=10).image(2, 2, 7, 5, [1] * 35)
    save(g.trailer(), 'screen_0x0')
    g = Gif(0, 0, PAL8)
    g.gce(delay=10).image(3, 2, 4, 4, grad(4, 4, 8))
    save(g.trailer(), 'screen_0x0_offset')
    g = Gif(0, 0, PAL8)
    g.gce(delay=10).image(0, 0, 0, 0, [])
    save(g.trailer(), 'screen_0x0_frame_0x0')
    g = Gif(0, 5, PAL8)
    g.gce(delay=10).image(0, 0, 0, 3, [], mcs=2)
    save(g.trailer(), 'screen_0x5_frame_0x3')
    # zero-sized frames inside an animation
    g = Gif(6, 6, PAL8)
    g.gce(delay=10).image(0, 0, 6, 6, grad(6, 6, 8))
    g.gce(delay=10, disposal=2).image(2, 2, 0, 3, [], mcs=2)
    g.gce(delay=10).image(2, 2, 3, 0, [], mcs=2)
    g.gce(delay=10).image(1, 1, 0, 0, [], mcs=2)
    g.gce(delay=10, trans=0).image(0, 0, 3, 3, checker(3, 3, 0, 5))
    save(g.trailer(), 'zero_size_frames')
    # zero-sized frame with junk LZW (Wuffs still validates it)
    g = Gif(6, 6, PAL8)
    g.gce(delay=10).image(0, 0, 6, 6, grad(6, 6, 8))
    g.gce(delay=10).image(2, 2, 0, 3, lzw_data=pack_codes([(4, 3), (1, 3), (15, 4), (3, 4)]), mcs=2)
    g.gce(delay=10).image(2, 2, 3, 0, lzw_data=pack_codes([(4, 3), (7, 3), (1, 3)]), mcs=2)
    g.gce(delay=10).image(2, 2, 0, 0, lzw_data=pack_codes([(4, 3), (7, 3)]), mcs=2, interlace=True)
    g.gce(delay=10).image(0, 0, 2, 2, [1, 2, 3, 4])
    save(g.trailer(), 'zero_size_frames_junk')
    # 1x1 GIF, 1-pixel-wide and tall frames
    save(Gif(1, 1, PAL4).image(0, 0, 1, 1, [2]).trailer(), 'one_pixel')
    g = Gif(1, 40, PAL16)
    g.gce(delay=10).image(0, 0, 1, 40, [i % 16 for i in range(40)])
    g.gce(delay=10).image(0, 3, 1, 30, [5] * 30, interlace=True)
    save(g.trailer(), 'one_pixel_wide')
    g = Gif(300, 1, PAL16)
    g.gce(delay=10).image(0, 0, 300, 1, [i % 16 for i in range(300)])
    save(g.trailer(), 'one_pixel_tall')


# ------------------------------------------------------------------ LZW
def lzw_cases():
    rnd = random.Random(7)
    for mcs in range(0, 9):
        maxv = max(1, 1 << mcs)
        w, h = 20, 15
        idx = px(w, h, lambda x, y: (x * 3 + y * 5 + (x * y) % 7) % maxv)
        g = Gif(w, h, PAL256)
        if mcs == 0:
            # Wuffs accepts literal width 0 (clear=1, end=2, only index 0 is codable).
            g.gce(delay=10).image(0, 0, w, h, [0] * (w * h), mcs=0)
            g.gce(delay=10).image(0, 0, 4, 4, [0] * 16, mcs=0, lzw_kw={'clear_every': 3})
            g.gce(delay=10, trans=1).image(2, 2, 5, 5, [0] * 25, mcs=0, lzw_kw={'initial_clear': False})
        else:
            g.gce(delay=10).image(0, 0, w, h, idx, mcs=mcs)
            g.gce(delay=10, trans=0).image(2, 2, 8, 8, px(8, 8, lambda x, y: (x + y) % maxv), mcs=mcs)
        save(g.trailer(), f'lzw_mcs{mcs}')
    # literal width bigger than the data needs
    g = Gif(10, 10, PAL4)
    g.gce(delay=10).image(0, 0, 10, 10, grad(10, 10, 4), mcs=8)
    g.gce(delay=10).image(0, 0, 10, 10, grad(10, 10, 4), mcs=7)
    save(g.trailer(), 'lzw_mcs_wide')
    # invalid literal widths (Chrome stops reading at that frame)
    for mcs in (9, 11, 12, 255):
        g = Gif(8, 8, PAL4)
        g.gce(delay=10).image(0, 0, 8, 8, grad(8, 8, 4))
        g.gce(delay=10).image(0, 0, 8, 8, lzw_data=lzw(grad(8, 8, 4), 2), mcs=mcs)
        g.gce(delay=10).image(0, 0, 8, 8, [1] * 64)
        save(g.trailer(), f'lzw_mcs{mcs}_frame1')
        g = Gif(8, 8, PAL4)
        g.gce(delay=10).image(0, 0, 8, 8, lzw_data=lzw(grad(8, 8, 4), 2), mcs=mcs)
        save(g.trailer(), f'lzw_mcs{mcs}_frame0')
    # clear codes mid-stream
    noise = [rnd.randrange(256) for _ in range(64 * 64)]
    for every in (1, 2, 3, 50, 300, 1000):
        g = Gif(64, 64, PAL256)
        g.gce(delay=10).image(0, 0, 64, 64, noise, mcs=8, lzw_kw={'clear_every': every})
        save(g.trailer(), f'lzw_clear_every_{every}')
    smooth = px(64, 64, lambda x, y: ((x // 4) + (y // 4)) % 4)
    g = Gif(64, 64, PAL4)
    g.gce(delay=10).image(0, 0, 64, 64, smooth, mcs=2, lzw_kw={'clear_every': 7})
    g.gce(delay=10).image(0, 0, 64, 64, smooth[::-1], mcs=2, lzw_kw={'extra_clears_at': [1, 2, 100, 101, 102, 2000]})
    save(g.trailer(), 'lzw_clear_mcs2')
    # full 4096-entry table without a clear code (deferred clear)
    big = [rnd.randrange(256) for _ in range(160 * 120)]
    g = Gif(160, 120, PAL256)
    g.gce(delay=10).image(0, 0, 160, 120, big, mcs=8, lzw_kw={'clear_when_full': False})
    save(g.trailer(), 'lzw_full_table_no_clear')
    small = [rnd.randrange(4) for _ in range(200 * 150)]
    g = Gif(200, 150, PAL4)
    g.gce(delay=10).image(0, 0, 200, 150, small, mcs=2, lzw_kw={'clear_when_full': False})
    g.gce(delay=10).image(0, 0, 200, 150, small[::-1], mcs=2, lzw_kw={'clear_when_full': True})
    save(g.trailer(), 'lzw_full_table_no_clear_mcs2')
    # no leading clear code, missing end code, both
    idx = grad(12, 12, 4)
    for name, kw in (('no_initial_clear', {'initial_clear': False}), ('no_end_code', {'end_code': False}),
                     ('no_clear_no_end', {'initial_clear': False, 'end_code': False})):
        g = Gif(12, 12, PAL4)
        g.gce(delay=10).image(0, 0, 12, 12, idx, lzw_kw=kw)
        g.gce(delay=10, trans=0).image(2, 2, 6, 6, grad(6, 6, 4), lzw_kw=kw)
        save(g.trailer(), 'lzw_' + name)
    # extra data after the end code: in the same sub-block, and in extra sub-blocks
    data = lzw(idx, 2) + bytes([0xff, 0x13, 0x77, 0x00, 0x42])
    g = Gif(12, 12, PAL4)
    g.gce(delay=10).image(0, 0, 12, 12, lzw_data=data, mcs=2)
    g.gce(delay=10).image(0, 0, 12, 12, lzw_data=lzw(idx[::-1], 2) + bytes(range(1, 250)) * 3, mcs=2, block_size=7)
    g.gce(delay=10).image(0, 0, 4, 4, [1] * 16)
    save(g.trailer(), 'lzw_extra_after_end')
    # too much pixel data (more pixels than the frame holds)
    g = Gif(10, 10, PAL4)
    g.gce(delay=10).image(0, 0, 10, 10, lzw_data=lzw(grad(10, 10, 4) + [3] * 77, 2), mcs=2)
    g.gce(delay=10).image(0, 0, 10, 10, lzw_data=lzw(grad(10, 10, 4) + [1] * 300, 2, end_code=False), mcs=2, interlace=True)
    g.gce(delay=10).image(0, 0, 3, 3, [2] * 9)
    save(g.trailer(), 'lzw_too_much_data')
    # codes that reference entries that do not exist yet (code > next free entry)
    base = grad(16, 16, 4)
    codes = lzw_codes(base, 2)
    for at in (0, 1, 2, 5, 30, len(codes) - 3, len(codes) - 2):
        c2 = list(codes)
        w = c2[min(at + 1, len(c2) - 1)][1]
        c2.insert(at + 1, ((1 << w) - 1, w))
        g = Gif(16, 16, PAL4)
        g.gce(delay=10).image(0, 0, 16, 16, lzw_data=pack_codes(c2), mcs=2)
        g.gce(delay=10, trans=0).image(0, 0, 16, 16, lzw_data=pack_codes(c2), mcs=2)
        g.gce(delay=10).image(0, 0, 16, 16, base[::-1])
        save(g.trailer(), f'lzw_bad_code_at_{at}')
    # bad code right after a clear, and code == next free entry right after a clear
    g = Gif(8, 8, PAL4)
    g.gce(delay=10).image(0, 0, 8, 8, grad(8, 8, 4))
    g.gce(delay=10).image(0, 0, 8, 8, lzw_data=pack_codes([(4, 3), (6, 3), (1, 3)]), mcs=2)
    g.gce(delay=10).image(0, 0, 8, 8, lzw_data=pack_codes([(4, 3), (5, 3)]), mcs=2)
    g.gce(delay=10).image(0, 0, 8, 8, lzw_data=pack_codes([(4, 3), (4, 3), (4, 3), (2, 3), (6, 3), (5, 4)]), mcs=2)
    g.gce(delay=10).image(0, 0, 8, 8, [3] * 64)
    save(g.trailer(), 'lzw_bad_after_clear')
    # bad code after the frame is complete (ignored by Chrome), also for interlaced frames
    codes = lzw_codes(base, 2, end_code=False)
    bad = pack_codes(codes + [(4095 & ((1 << codes[-1][1]) - 1), codes[-1][1])] * 3)
    g = Gif(16, 16, PAL4)
    g.gce(delay=10).image(0, 0, 16, 16, lzw_data=bad, mcs=2)
    icodes = lzw_codes(interlace_order(base, 16, 16), 2, end_code=False)
    g.gce(delay=10).image(0, 0, 16, 16, lzw_data=pack_codes(icodes + [((1 << icodes[-1][1]) - 1, icodes[-1][1])]), mcs=2, interlace=True)
    g.gce(delay=10).image(0, 0, 4, 4, [1] * 16)
    save(g.trailer(), 'lzw_bad_after_complete')
    # KwKwK heavy (long runs), long strings close to the 4096 table limit
    g = Gif(255, 255, PAL4)
    g.gce(delay=10).image(0, 0, 255, 255, [1] * (255 * 255), mcs=2)
    g.gce(delay=10).image(0, 0, 255, 255, [(i // 9000) % 4 for i in range(255 * 255)], mcs=2, lzw_kw={'clear_when_full': False})
    save(g.trailer(), 'lzw_long_runs')
    # sub-block sizes: 1-byte blocks, odd sizes
    for bs in (1, 2, 17, 254):
        g = Gif(20, 20, PAL16)
        g.gce(delay=10).image(0, 0, 20, 20, grad(20, 20, 16), block_size=bs)
        save(g.trailer(), f'subblock_size_{bs}')
    # no data at all (just the terminator), and only a clear + end code
    g = Gif(6, 6, PAL4)
    g.gce(delay=10).image(0, 0, 6, 6, [1] * 36)
    g.gce(delay=10).image(0, 0, 6, 6, data_blocks=b'\x00', mcs=2)
    g.gce(delay=10).image(0, 0, 6, 6, lzw_data=pack_codes([(4, 3), (5, 3)]), mcs=2)
    g.gce(delay=10).image(0, 0, 6, 6, [2] * 36)
    save(g.trailer(), 'lzw_empty_data')


# ------------------------------------------------------------------ delays and extensions
def extension_cases():
    g = Gif(4, 4, PAL4).loop(0)
    for d in (0, 1, 2, 3, 9, 10, 11, 100, 65535):
        g.gce(delay=d).image(0, 0, 4, 4, [d % 4] * 16)
    g.image(0, 0, 4, 4, [1] * 16)  # no GCE at all
    save(g.trailer(), 'delays')
    # multiple GCEs before one image: the last wins entirely
    g = Gif(6, 6, PAL4)
    g.gce(delay=10).image(0, 0, 6, 6, grad(6, 6, 4))
    g.gce(delay=50, trans=1, disposal=2).gce(delay=20, disposal=1)
    g.image(1, 1, 4, 4, checker(4, 4, 1, 2))
    g.gce(delay=7, disposal=3).gce(delay=30, trans=2)
    g.image(0, 0, 3, 3, checker(3, 3, 2, 3))
    g.gce(delay=8).comment(b'between').gce(delay=9, disposal=2, trans=3).image(2, 2, 4, 4, checker(4, 4, 3, 0))
    g.gce(delay=10).image(0, 0, 2, 2, [1] * 4)
    save(g.trailer(), 'multiple_gce')
    # GCE with odd block sizes (Chrome stops reading there)
    for blen, body in ((3, b'\x00\x0a\x00'), (5, b'\x00\x0a\x00\x00\x00'), (0, b''), (6, b'\x05\x0a\x00\x01\x00\x00')):
        for where in (0, 1):
            g = Gif(6, 6, PAL4)
            if where == 1:
                g.gce(delay=10).image(0, 0, 6, 6, grad(6, 6, 4))
            g.gce(block_len=blen, body=body)
            g.image(1, 1, 4, 4, [2] * 16)
            g.gce(delay=10).image(0, 0, 2, 2, [3] * 4)
            save(g.trailer(), f'gce_len{blen}_frame{where}')
    # GCE with a non-zero terminator
    g = Gif(6, 6, PAL4)
    g.gce(delay=10).image(0, 0, 6, 6, grad(6, 6, 4))
    g.raw(b'\x21\xf9\x04\x00\x0a\x00\x00\x02\xaa\xbb\x00')
    g.image(1, 1, 4, 4, [2] * 16)
    save(g.trailer(), 'gce_bad_terminator')
    # GCE after the last frame (ignored)
    g = Gif(6, 6, PAL4).gce(delay=10).image(0, 0, 6, 6, grad(6, 6, 4)).gce(delay=99, disposal=2, trans=1)
    save(g.trailer(), 'gce_after_last')
    # comments, plain text, unknown extensions, application extensions everywhere
    g = Gif(8, 8, PAL4)
    g.comment(b'').comment(b'x' * 600).raw(b'\x21\xfe\x00')
    g.plaintext()
    g.raw(b'\x21\x01\x05abcde\x03xyz\x00')  # plain text with odd header size
    g.raw(b'\x21\x42\x02hi\x00')  # unknown label
    g.raw(b'\x21\x00\x00')  # label 0, empty
    g.app(b'XMP DataXMP', b'<x:xmpmeta>' * 40)
    g.app(b'ICCRGBG1012', bytes(range(256)) * 2)
    g.app(b'MGK8BIM0000', b'\x01\x02\x03')
    g.raw(b'\x21\xff\x05SHORT\x02ab\x00')  # application block of size 5
    g.raw(b'\x21\xff\x0dTOOLONGIDENT1\x00')  # size 13
    g.gce(delay=10).image(0, 0, 8, 8, grad(8, 8, 4))
    g.comment(b'mid').plaintext().app(b'NETSCAPE2.0', b'\x01\x05\x00')
    g.gce(delay=10, trans=0).image(1, 1, 6, 6, grad(6, 6, 4))
    g.comment(b'end')
    save(g.trailer(), 'extensions_everywhere')
    # application extension of size 0 ("21 FF 00": nothing more is read)
    g = Gif(6, 6, PAL4)
    g.raw(b'\x21\xff\x00')
    g.gce(delay=10).image(0, 0, 6, 6, grad(6, 6, 4))
    g.raw(b'\x21\xff\x00')
    g.gce(delay=10).image(1, 1, 3, 3, [2] * 9)
    save(g.trailer(), 'app_ext_size0')
    # loop counts
    for loops in (0, 1, 2, 5, 65535):
        g = Gif(4, 4, PAL4).loop(loops)
        g.gce(delay=10).image(0, 0, 4, 4, [1] * 16).gce(delay=10).image(0, 0, 4, 4, [2] * 16)
        save(g.trailer(), f'loop_{loops}')
    g = Gif(4, 4, PAL4).loop(3, ident=b'ANIMEXTS1.0')
    g.gce(delay=10).image(0, 0, 4, 4, [1] * 16).gce(delay=10).image(0, 0, 4, 4, [2] * 16)
    save(g.trailer(), 'loop_animexts_3')
    g = Gif(4, 4, PAL4).loop(4)
    g.gce(delay=10).image(0, 0, 4, 4, [1] * 16)
    save(g.trailer(), 'loop_single_frame')
    # netscape sub-block id 2 and 3, size 5, size 0, size 2
    for name, sub in (('id2', b'\x03\x02\x10\x00'), ('id3', b'\x03\x03\x05\x00'), ('size5', b'\x05\x01\x07\x00\x00\x00'),
                      ('size2', b'\x02\x01\x07'), ('size0', b'')):
        g = Gif(4, 4, PAL4)
        g.raw(b'\x21\xff\x0bNETSCAPE2.0' + sub + b'\x00')
        g.gce(delay=10).image(0, 0, 4, 4, [1] * 16).gce(delay=10).image(0, 0, 4, 4, [2] * 16)
        save(g.trailer(), f'loop_netscape_{name}')
    # several NETSCAPE blocks, and one after the first frame / after the last frame
    g = Gif(4, 4, PAL4).loop(3).loop(7)
    g.gce(delay=10).image(0, 0, 4, 4, [1] * 16).gce(delay=10).image(0, 0, 4, 4, [2] * 16)
    save(g.trailer(), 'loop_twice')
    g = Gif(4, 4, PAL4).loop(3)
    g.gce(delay=10).image(0, 0, 4, 4, [1] * 16).loop(9).gce(delay=10).image(0, 0, 4, 4, [2] * 16)
    save(g.trailer(), 'loop_after_frame0')
    g = Gif(4, 4, PAL4)
    g.gce(delay=10).image(0, 0, 4, 4, [1] * 16).gce(delay=10).image(0, 0, 4, 4, [2] * 16).loop(6)
    save(g.trailer(), 'loop_after_last')
    # garbage between frames, data after the trailer, missing trailer
    g = Gif(6, 6, PAL4)
    g.gce(delay=10).image(0, 0, 6, 6, grad(6, 6, 4))
    g.raw(b'\x00')
    g.gce(delay=10).image(0, 0, 6, 6, [1] * 36)
    save(g.trailer(), 'garbage_between_frames')
    g = Gif(6, 6, PAL4)
    g.gce(delay=10).image(0, 0, 6, 6, grad(6, 6, 4)).trailer()
    g.raw(b'\x21\xf9\x04\x00\x0a\x00\x00\x00,\x00\x00\x00\x00\x02\x00\x02\x00\x00\x02\x02\x44\x01\x00;junk')
    save(g, 'data_after_trailer')
    save(Gif(6, 6, PAL4).gce(delay=10).image(0, 0, 6, 6, grad(6, 6, 4)).gce(delay=10).image(0, 0, 6, 6, [2] * 36), 'no_trailer')
    # header variants
    for ver in (b'GIF87a', b'GIF89a', b'GIF88a', b'GIF89b', b'gif89a', b'GIF8'):
        g = Gif(4, 4, PAL4, version=ver)
        g.gce(delay=10).image(0, 0, 4, 4, [1] * 16).gce(delay=10).image(0, 0, 4, 4, [2] * 16)
        save(g.trailer(), 'header_' + ver.decode().replace('.', ''))
    save(b'GIF89a', 'header_only6')
    save(Gif(4, 4, PAL4).trailer().bytes(), 'no_frames')
    save(Gif(4, 4, PAL4).bytes(), 'lsd_only')
    save(b'\x89PNG\r\n\x1a\n' + bytes(40), 'not_gif_png')


# ------------------------------------------------------------------ damaged frames inside animations
def damaged_cases():
    base = grad(10, 10, 8)
    variants = {
        'eoi': lambda: lzw(base[:37], 3),
        'short': lambda: lzw(base[:37], 3, end_code=False),
        'bad': lambda: pack_codes(lzw_codes(base[:37], 3, end_code=False) + [(63, 6)] + lzw_codes(base[37:], 3)),
    }
    for kind, mk in variants.items():
        for pattern in ('dep', 'opaque', 'chain', 'prev'):
            g = Gif(10, 10, PAL8)
            g.gce(delay=10).image(0, 0, 10, 10, grad(10, 10, 8))
            if pattern == 'dep':
                g.gce(delay=10, trans=0).image(0, 0, 10, 10, lzw_data=mk(), mcs=3)
                g.gce(delay=10, trans=0).image(2, 2, 5, 5, checker(5, 5, 0, 4))
                g.gce(delay=10, trans=0).image(0, 0, 3, 3, checker(3, 3, 0, 6))
                g.gce(delay=10).image(0, 0, 10, 10, [5] * 100)
                g.gce(delay=10, trans=0).image(4, 4, 3, 3, checker(3, 3, 0, 2))
            elif pattern == 'opaque':
                g.gce(delay=10).image(2, 2, 10, 10, lzw_data=mk(), mcs=3)
                g.gce(delay=10).image(0, 0, 8, 8, checker(8, 8, 1, 2))
                g.gce(delay=10, trans=0).image(0, 0, 3, 3, checker(3, 3, 0, 6))
            elif pattern == 'chain':
                g.gce(delay=10, disposal=2).image(1, 1, 10, 10, lzw_data=mk(), mcs=3)
                g.gce(delay=10, trans=0).image(3, 3, 4, 4, checker(4, 4, 0, 4))
                g.gce(delay=10, disposal=3, trans=0).image(0, 0, 4, 4, checker(4, 4, 0, 6))
                g.gce(delay=10).image(0, 0, 10, 10, [5] * 100)
            else:
                g.gce(delay=10, disposal=3).image(0, 0, 10, 10, lzw_data=mk(), mcs=3)
                g.gce(delay=10, trans=0).image(3, 3, 4, 4, checker(4, 4, 0, 4))
                g.gce(delay=10, disposal=1).image(0, 0, 10, 10, lzw_data=mk(), mcs=3)
                g.gce(delay=10, trans=0).image(5, 5, 4, 4, checker(4, 4, 0, 1))
            save(g.trailer(), f'damaged_{kind}_{pattern}')


# ------------------------------------------------------------------ random compositing stress
def random_gif(seed, damaged=False):
    r = random.Random(seed)
    W, H = r.randint(1, 40), r.randint(1, 40)
    gpal = None if r.random() < 0.1 else [tuple(r.randrange(256) for _ in range(3)) for _ in range(r.choice([2, 4, 8, 16, 256]))]
    g = Gif(W, H, gpal, bg=r.randrange(256))
    if r.random() < 0.7:
        g.loop(r.choice([0, 0, 1, 3]))
    nframes = r.randint(1, 9)
    for k in range(nframes):
        if r.random() < 0.3:
            fw, fh, fx, fy = W, H, 0, 0
        else:
            fw, fh = r.randint(1, W + 4), r.randint(1, H + 4)
            fx, fy = r.randint(0, W + 2), r.randint(0, H + 2)
            if r.random() < 0.6:
                fx, fy = min(fx, max(0, W - fw)), min(fy, max(0, H - fh))
        lct = None
        if r.random() < 0.3 or gpal is None and r.random() < 0.7:
            lct = [tuple(r.randrange(256) for _ in range(3)) for _ in range(r.choice([2, 4, 16, 64]))]
        pal_n = len(lct) if lct else (len(gpal) if gpal else 4)
        top = pal_n if r.random() < 0.85 else min(256, pal_n * 2 + 3)
        trans = r.randrange(pal_n) if r.random() < 0.5 else None
        style = r.random()
        if style < 0.3:
            idx = [r.randrange(top) for _ in range(fw * fh)]
        elif style < 0.6:
            a, b = r.randrange(top), r.randrange(top)
            s = r.randint(1, 4)
            idx = px(fw, fh, lambda x, y: a if ((x // s + y // s) % 2) else b)
        else:
            idx = px(fw, fh, lambda x, y: (x + y * r.randint(1, 3)) % top)
        if trans is not None and r.random() < 0.5:
            idx = [trans if r.random() < 0.4 else v for v in idx]
        mcs = max(2, (top - 1).bit_length()) if r.random() < 0.9 else 8
        kw = {}
        if r.random() < 0.2:
            kw['clear_every'] = r.randint(1, 60)
        if r.random() < 0.2:
            kw['clear_when_full'] = False
        interlace = r.random() < 0.2
        disposal = r.choice([0, 1, 1, 2, 2, 3, 3, 4, 5, 7])
        g.gce(disposal=disposal, delay=r.choice([0, 1, 2, 5, 10, 33]), trans=trans)
        if damaged and r.random() < 0.35:
            seq = interlace_order(idx, fw, fh) if interlace else idx
            cut = r.randint(0, max(0, len(seq) - 1))
            kind = r.random()
            if kind < 0.4:
                data = lzw(seq[:cut], mcs)
            elif kind < 0.7:
                data = lzw(seq[:cut], mcs, end_code=False)
            else:
                codes = lzw_codes(seq[:cut], mcs, end_code=False)
                wdt = codes[-1][1] if codes else mcs + 1
                data = pack_codes(codes + [((1 << wdt) - 1, wdt)] + lzw_codes(seq[cut:], mcs))
            g.image(fx, fy, fw, fh, lzw_data=data, lct=lct, interlace=interlace, mcs=mcs)
        else:
            g.image(fx, fy, fw, fh, idx, lct=lct, interlace=interlace, mcs=mcs, lzw_kw=kw)
    return g.trailer()


def random_cases():
    for s in range(150):
        save(random_gif(1000 + s), f'random_{s:03d}', RAND)
    for s in range(80):
        save(random_gif(5000 + s, damaged=True), f'random_damaged_{s:03d}', RAND)


# ------------------------------------------------------------------ truncation at many offsets
def truncation_cases():
    bases = {}
    g = Gif(10, 10, PAL8).loop(0).comment(b'hello')
    g.gce(delay=10).image(0, 0, 10, 10, grad(10, 10, 8), block_size=40)
    g.gce(delay=20, trans=0, disposal=2).image(2, 2, 6, 6, checker(6, 6, 0, 3), block_size=9)
    g.gce(delay=30, trans=1, disposal=3).image(1, 1, 8, 8, checker(8, 8, 1, 5), lct=PAL4[::-1], block_size=5)
    g.gce(delay=40).image(0, 0, 10, 10, grad(10, 10, 8)[::-1], interlace=True, block_size=11)
    bases['anim'] = g.trailer().bytes()
    g = Gif(9, 13, PAL16)
    g.gce(delay=10).image(0, 0, 9, 13, px(9, 13, lambda x, y: (x * y) % 16), interlace=True, block_size=6)
    g.gce(delay=10, trans=0).image(0, 0, 9, 13, checker(9, 13, 0, 7), interlace=True, block_size=6)
    bases['interlaced'] = g.trailer().bytes()
    g = Gif(12, 6)
    g.image(0, 0, 12, 6, grad(12, 6, 4), lct=PAL4, block_size=3)
    g.gce(delay=5, trans=2).image(3, 1, 6, 4, grad(6, 4, 4), lct=PAL4, block_size=3)
    bases['nogct'] = g.trailer().bytes()
    for name, data in bases.items():
        save(data, f'trunc_{name}_full', TRUNC)
        for cut in range(0, len(data)):
            save(data[:cut], f'trunc_{name}_{cut:04d}', TRUNC)


disposal_cases()
transparency_cases()
interlace_cases()
palette_cases()
geometry_cases()
lzw_cases()
extension_cases()
damaged_cases()
random_cases()
truncation_cases()
print(f'wrote {count} files')
