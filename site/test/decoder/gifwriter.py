"""Tiny byte-exact GIF writer for decoder edge-case tests.

Every structural element can be overridden so tests can produce malformed files on purpose.
"""
import struct


def pack_codes(codes):
    """codes: iterable of (code, width). LSB-first bit packing as GIF uses."""
    out = bytearray()
    acc = 0
    nbits = 0
    for code, width in codes:
        acc |= (code & ((1 << width) - 1)) << nbits
        nbits += width
        while nbits >= 8:
            out.append(acc & 0xFF)
            acc >>= 8
            nbits -= 8
    if nbits:
        out.append(acc & 0xFF)
    return bytes(out)


def lzw_codes(indices, mcs, clear_every=None, clear_when_full=True, initial_clear=True,
              end_code=True, extra_clears_at=()):
    """Standard GIF LZW encoder that returns the list of (code, width).

    clear_every: emit a clear code after this many emitted codes (mid-stream clears).
    clear_when_full: if False, keep coding with a full 4096 table (deferred clear).
    extra_clears_at: positions (in input pixels) where a clear code is forced.
    """
    clear = 1 << mcs
    eoi = clear + 1
    out = []
    width = mcs + 1

    def reset():
        return {(i,): i for i in range(clear)}, eoi + 1, mcs + 1

    table, nxt, width = reset()
    if initial_clear:
        out.append((clear, width))
    if not indices:
        if end_code:
            out.append((eoi, width))
        return out
    force = set(extra_clears_at)
    w = (indices[0],)
    emitted = 0
    for pos in range(1, len(indices)):
        k = indices[pos]
        wk = w + (k,)
        if wk in table and pos not in force:
            w = wk
            continue
        out.append((table[w], width))
        emitted += 1
        if pos in force or (clear_every and emitted % clear_every == 0):
            # Add nothing; emit clear and reset.
            out.append((clear, width))
            table, nxt, width = reset()
        elif nxt < 4096:
            table[wk] = nxt
            nxt += 1
            if nxt > (1 << width) and width < 12:
                width += 1
        elif clear_when_full:
            out.append((clear, width))
            table, nxt, width = reset()
        w = (k,)
    out.append((table[w], width))
    if end_code:
        out.append((eoi, width))
    return out


def lzw(indices, mcs, **kw):
    return pack_codes(lzw_codes(indices, mcs, **kw))


def subblocks(data, size=255, terminator=True):
    out = bytearray()
    for i in range(0, len(data), size):
        chunk = data[i:i + size]
        out.append(len(chunk))
        out += chunk
    if terminator:
        out.append(0)
    return bytes(out)


def table_bits(n):
    """Size field for a colour table holding n entries (n is padded up to a power of two)."""
    b = 0
    while (2 << b) < n:
        b += 1
    return b


def color_table(pal, bits=None):
    if bits is None:
        bits = table_bits(len(pal))
    n = 2 << bits
    out = bytearray()
    for i in range(n):
        r, g, b = pal[i] if i < len(pal) else (0, 0, 0)
        out += bytes((r, g, b))
    return bytes(out), bits


class Gif:
    def __init__(self, w, h, gct=None, gct_bits=None, bg=0, version=b'GIF89a', aspect=0,
                 gct_flag=None, gct_raw=None):
        self.b = bytearray()
        self.b += version
        flags = 0
        tbl = b''
        if gct is not None:
            tbl, bits = color_table(gct, gct_bits)
            flags = 0x80 | 0x70 | bits
        if gct_flag is not None:
            flags = gct_flag
        if gct_raw is not None:
            tbl = gct_raw
        self.b += struct.pack('<HHBBB', w, h, flags, bg, aspect)
        self.b += tbl

    def raw(self, data):
        self.b += data
        return self

    def loop(self, n=0, ident=b'NETSCAPE2.0', sub_id=1):
        self.b += b'\x21\xff' + bytes([len(ident)]) + ident
        self.b += bytes([3, sub_id]) + struct.pack('<H', n) + b'\x00'
        return self

    def gce(self, disposal=0, delay=0, trans=None, user_input=False, block_len=4, raw_flags=None,
            body=None):
        flags = (disposal & 7) << 2
        if user_input:
            flags |= 2
        if trans is not None:
            flags |= 1
        if raw_flags is not None:
            flags = raw_flags
        if body is None:
            body = bytes([flags]) + struct.pack('<H', delay) + bytes([trans or 0])
        self.b += b'\x21\xf9' + bytes([block_len]) + body + b'\x00'
        return self

    def comment(self, text=b'hello'):
        self.b += b'\x21\xfe' + subblocks(text)
        return self

    def plaintext(self):
        self.b += b'\x21\x01\x0c' + struct.pack('<HHHHBBBB', 0, 0, 10, 10, 8, 8, 1, 0)
        self.b += subblocks(b'Hello')
        return self

    def app(self, ident=b'XMP DataXMP', data=b'some data'):
        self.b += b'\x21\xff' + bytes([len(ident)]) + ident + subblocks(data)
        return self

    def image(self, x, y, w, h, indices=None, lct=None, lct_bits=None, interlace=False, mcs=None,
              lzw_data=None, data_blocks=None, block_size=255, flags=None, lzw_kw=None,
              terminator=True, lct_raw=None):
        """indices: row-major list of w*h colour indices in display order (interlace is applied here)."""
        fl = 0
        tbl = b''
        if lct is not None:
            tbl, bits = color_table(lct, lct_bits)
            fl |= 0x80 | bits
        if interlace:
            fl |= 0x40
        if flags is not None:
            fl = flags
        if lct_raw is not None:
            tbl = lct_raw
        self.b += b'\x2c' + struct.pack('<HHHHB', x, y, w, h, fl) + tbl
        if mcs is None:
            mx = max(indices) if indices else 0
            mcs = max(2, (mx).bit_length())
        self.b += bytes([mcs])
        if data_blocks is not None:
            self.b += data_blocks
            return self
        if lzw_data is None:
            seq = indices
            if interlace:
                seq = interlace_order(indices, w, h)
            lzw_data = lzw(seq, mcs, **(lzw_kw or {}))
        self.b += subblocks(lzw_data, block_size, terminator)
        return self

    def trailer(self):
        self.b += b'\x3b'
        return self

    def bytes(self):
        return bytes(self.b)

    def save(self, path):
        with open(path, 'wb') as f:
            f.write(self.b)
        return path


def interlace_order(indices, w, h):
    rows = []
    for start, step in ((0, 8), (4, 8), (2, 4), (1, 2)):
        rows += list(range(start, h, step))
    out = []
    for r in rows:
        out += indices[r * w:(r + 1) * w]
    return out
