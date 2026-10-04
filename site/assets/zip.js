// A ZIP writer for files that are already compressed, such as PNG and JPEG: each file is stored as
// it is (method 0), so making the ZIP only adds headers and a checksum.

const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c >>> 0;
}

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: [{ name, bytes: Uint8Array }] -> Blob. Names are UTF-8; the date is local time, as ZIP has it.
export function zip(files, date = new Date()) {
  if (files.length > 0xffff) throw new Error('A ZIP file can hold at most 65,535 files without the ZIP64 extension.');
  const enc = new TextEncoder();
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const UTF8 = 0x0800;
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const size = f.bytes.length;
    const crc = crc32(f.bytes);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); // local file header
    h.setUint16(4, 20, true); // version needed: 2.0
    h.setUint16(6, UTF8, true);
    h.setUint16(8, 0, true); // stored
    h.setUint16(10, time, true);
    h.setUint16(12, day, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, size, true);
    h.setUint32(22, size, true);
    h.setUint16(26, name.length, true);
    h.setUint16(28, 0, true);
    parts.push(h, name, f.bytes);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); // central directory entry
    c.setUint16(4, 20, true); // made by: MS-DOS attributes, version 2.0
    c.setUint16(6, 20, true);
    c.setUint16(8, UTF8, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, day, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, size, true);
    c.setUint32(24, size, true);
    c.setUint16(28, name.length, true);
    // extra field, comment, disk number, internal and external attributes: all 0
    c.setUint32(42, offset, true);
    central.push(c, name);
    offset += 30 + name.length + size;
    if (offset > 0xffffffff) throw new Error('That is more than a 4 GB ZIP file can hold.');
  }
  const dirSize = central.reduce((a, p) => a + p.byteLength, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); // end of central directory
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, dirSize, true);
  e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, e], { type: 'application/zip' });
}
