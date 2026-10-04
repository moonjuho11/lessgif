// Node self-test of the API (no browser): decodeFrames() matches decodeGif(), yielded frames are
// caller-owned (scribbling on them never changes later frames), parseGif() shape, input types,
// error messages.
// usage: node selftest.mjs [files or dirs...]   (default: edge/ random/ trunc/ wikimedia/)
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseGif, decodeGif, decodeFrames, decodeFrameIndices } from '../../assets/gifdecode.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const inputs = args.length ? args : ['edge', 'random', 'trunc', 'wikimedia'].map(d => path.join(here, d));
const files = [];
for (const p of inputs) {
  if (fs.statSync(p).isDirectory()) for (const f of fs.readdirSync(p).sort()) { if (f.endsWith('.gif')) files.push(path.join(p, f)); }
  else files.push(p);
}

let checked = 0, threw = 0;
for (const f of files) {
  const bytes = new Uint8Array(fs.readFileSync(f));
  let ref;
  try { ref = decodeGif(bytes); } catch (e) { threw++; assert.match(e.message, /GIF|file/); continue; }
  // Generator gives the same frames, even when every yielded frame is scribbled on at once.
  const gen = [];
  for (const fr of decodeFrames(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))) {
    gen.push(fr.rgba.slice());
    fr.rgba.fill(0x55);
    assert.equal(fr.delay, ref.delays[fr.index]);
    assert.equal(fr.complete, ref.complete[fr.index]);
  }
  assert.equal(gen.length, ref.frames.length, f);
  for (let i = 0; i < gen.length; i++) assert.ok(Buffer.from(gen[i].buffer).equals(Buffer.from(ref.frames[i].buffer)), `${f} frame ${i}`);
  // onFrame sees the same arrays; scribbling on them inside the callback changes nothing later.
  const seen = [];
  const again = decodeGif(bytes, { onFrame: ({ index, rgba, frameCount }) => { assert.equal(frameCount, ref.frames.length); seen.push(rgba.slice()); rgba.fill(7); } });
  for (let i = 0; i < seen.length; i++) assert.ok(Buffer.from(seen[i].buffer).equals(Buffer.from(ref.frames[i].buffer)), `${f} onFrame ${i}`);
  assert.equal(again.frames.length, ref.frames.length);
  // All frames are distinct buffers.
  assert.equal(new Set(ref.frames.map(a => a.buffer)).size, ref.frames.length);
  // parseGif shape; a parsed object can be passed back in.
  const g = parseGif(bytes);
  assert.equal(g.width, ref.width); assert.equal(g.height, ref.height); assert.equal(g.loopCount, ref.loopCount);
  for (const fr of g.frames) {
    for (const k of ['left', 'top', 'width', 'height', 'delay', 'disposal', 'transparentIndex']) assert.equal(typeof fr[k], 'number', k);
    assert.equal(typeof fr.interlaced, 'boolean');
    assert.ok(fr.palette instanceof Uint8Array);
  }
  const viaParsed = decodeGif(g);
  assert.equal(viaParsed.frames.length, ref.frames.length);
  if (g.frames.length) {
    const ix = decodeFrameIndices(g, 0);
    assert.equal(ix.indices.length, g.frames[0].width * g.frames[0].height);
  }
  checked++;
}

// Errors are plain English.
const expectThrow = (b, re) => assert.throws(() => decodeGif(b), e => { assert.match(e.message, re); return true; });
expectThrow(new Uint8Array(0), /empty/i);
expectThrow(new TextEncoder().encode('<!DOCTYPE html><html>'), /HTML/);
expectThrow(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0]), /PNG/);
expectThrow(new TextEncoder().encode('GIF89a'), /cut off/);
assert.throws(() => decodeGif('GIF89a'), /Uint8Array|ArrayBuffer|bytes/);

console.log(`selftest ok: ${checked} files decoded and cross-checked, ${threw} rejected with an error`);
