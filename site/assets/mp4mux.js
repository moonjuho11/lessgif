// Writes a video track as an MP4 file: H.264 ('avc1') or VP9 ('vp09') samples from WebCodecs'
// VideoEncoder, with any timing per frame. The whole file is built in memory with the index
// (moov) first, so it starts playing before it has fully loaded.

const enc = new TextEncoder();

// n as a big-endian unsigned integer of `bytes` bytes
function be(n, bytes) {
  const a = new Uint8Array(bytes);
  for (let i = bytes - 1; i >= 0; i--) {
    a[i] = n % 256;
    n = Math.floor(n / 256);
  }
  return a;
}
const u8 = (n) => be(n, 1);
const u16 = (n) => be(n, 2);
const u32 = (n) => be(n, 4);
const zeros = (n) => new Uint8Array(n);

function cat(parts) {
  const flat = parts.flat(Infinity);
  const out = new Uint8Array(flat.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of flat) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const box = (type, ...parts) => {
  const body = cat(parts);
  return cat([u32(body.length + 8), enc.encode(type), body]);
};
const fullBox = (type, version, flags, ...parts) => box(type, u8(version), be(flags, 3), ...parts);

const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32);

// Colour description codes, as in ISO/IEC 23091-2: 1 = BT.709, 6 = BT.601 (SMPTE 170M).
const COLR = { primaries: 1, transfer: 1, matrix: 1, fullRange: false };
const colr = (c) => box('colr', enc.encode('nclx'), u16(c.primaries), u16(c.transfer), u16(c.matrix), u8(c.fullRange ? 0x80 : 0));

// The VP9 codec configuration box (VP Codec ISO Media File Format Binding, version 1).
function vpcC({ profile, level, bitDepth = 8 }, c) {
  const chroma = 1; // 4:2:0, chroma samples sited with the luma samples
  return fullBox('vpcC', 1, 0, u8(profile), u8(level), u8((bitDepth << 4) | (chroma << 1) | (c.fullRange ? 1 : 0)), u8(c.primaries), u8(c.transfer), u8(c.matrix), u16(0));
}

function sampleEntry(t) {
  const name = zeros(32);
  const label = enc.encode(t.codec === 'avc' ? 'AVC Coding' : 'VP9 Coding');
  name[0] = label.length;
  name.set(label, 1);
  const config = t.codec === 'avc' ? box('avcC', new Uint8Array(t.description)) : vpcC(t.vp9, t.colr);
  return box(
    t.codec === 'avc' ? 'avc1' : 'vp09',
    zeros(6),
    u16(1), // data reference index
    zeros(16), // pre-defined and reserved
    u16(t.width),
    u16(t.height),
    u32(0x480000), // 72 dpi
    u32(0x480000),
    u32(0),
    u16(1), // frames per sample
    name,
    u16(0x18), // depth: colour, no alpha
    u16(0xffff),
    config,
    colr(t.colr),
  );
}

// track: { codec: 'avc' | 'vp9', width, height, timescale, description (avcC, for H.264),
//          vp9: { profile, level } (for VP9), colr: { primaries, transfer, matrix, fullRange },
//          samples: [{ data: Uint8Array, duration (in timescale units), key }] }
// Returns a Blob of the MP4 file.
export function mp4(track) {
  const { width, height, timescale, samples } = track;
  const t = { colr: COLR, ...track };
  const n = samples.length;
  if (!n) throw new Error('There are no frames to write.');
  if (!samples[0].key) throw new Error('The video has to start with a key frame.');
  const duration = samples.reduce((a, s) => a + s.duration, 0);
  const dataSize = samples.reduce((a, s) => a + s.data.length, 0);
  if (dataSize + 8 > 0xffffffff || duration > 0xffffffff) throw new Error('That video is too long for this tool.');

  // timing: runs of equal durations
  const stts = [];
  for (const s of samples) {
    const last = stts[stts.length - 1];
    if (last && last[1] === s.duration) last[0]++;
    else stts.push([1, s.duration]);
  }
  const keys = [];
  samples.forEach((s, i) => s.key && keys.push(i + 1));

  const ftyp = box('ftyp', enc.encode('isom'), u32(0x200), enc.encode(t.codec === 'avc' ? 'isomiso2avc1mp41' : 'isomiso2mp41'));
  const moov = (offset) =>
    box(
      'moov',
      fullBox('mvhd', 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u32(0x10000), u16(0x100), zeros(10), MATRIX, zeros(24), u32(2)),
      box(
        'trak',
        fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(duration), zeros(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(width * 0x10000), u32(height * 0x10000)),
        box(
          'mdia',
          fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0)), // language "und"
          fullBox('hdlr', 0, 0, u32(0), enc.encode('vide'), zeros(12), enc.encode('VideoHandler\0')),
          box(
            'minf',
            fullBox('vmhd', 0, 1, zeros(8)),
            box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
            box(
              'stbl',
              fullBox('stsd', 0, 0, u32(1), sampleEntry(t)),
              fullBox('stts', 0, 0, u32(stts.length), stts.map(([c, d]) => [u32(c), u32(d)])),
              keys.length < n ? fullBox('stss', 0, 0, u32(keys.length), keys.map(u32)) : [],
              fullBox('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1)), // one chunk with every sample
              fullBox('stsz', 0, 0, u32(0), u32(n), samples.map((s) => u32(s.data.length))),
              fullBox('stco', 0, 0, u32(1), u32(offset)),
            ),
          ),
        ),
      ),
    );
  const size = moov(0).length; // the offset doesn't change the size
  const head = moov(ftyp.length + size + 8);
  return new Blob([ftyp, head, u32(dataSize + 8), enc.encode('mdat'), ...samples.map((s) => s.data)], { type: 'video/mp4' });
}
