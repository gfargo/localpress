/**
 * Regression tests for gh-100 / OSS-544: the jsquash encoding path must view
 * sharp's raw pixel Buffer with its actual byteOffset/byteLength, not assume
 * it starts at offset 0 of the backing ArrayBuffer. Node/Bun Buffers are
 * frequently slices into a larger pooled ArrayBuffer, so `new
 * Uint8ClampedArray(buf.buffer)` alone reads unrelated heap memory whenever
 * byteOffset is non-zero.
 *
 * The fix (src/engine/image/optimize.ts, `encodeImage`) already honors
 * byteOffset/byteLength and asserts the resulting view length matches
 * width*height*4. These tests lock that in from two angles:
 *   1. A pure demonstration of the buffer-view bug itself, so the mechanism
 *      is documented and can't silently regress.
 *   2. An end-to-end check that `optimizeImage(..., { encoder: 'jsquash' })`
 *      preserves exact pixel data across many small encodes — the buffer
 *      size/allocation pattern most likely to produce a pooled, offset view.
 */

import { describe, expect, test } from 'bun:test';
import { optimizeImage } from '../../src/engine/image/optimize.ts';

async function sharpLib() {
  return (await import('sharp')).default;
}

describe('Buffer byteOffset semantics (the underlying bug)', () => {
  test('viewing buf.buffer directly reads the wrong bytes when buf is a sliced view', () => {
    // Simulate a Buffer that is a view into a larger, pooled ArrayBuffer —
    // exactly what sharp's raw().toBuffer() can return.
    const pool = Buffer.alloc(4096, 0xaa); // filled with sentinel "unrelated heap" bytes
    const offset = 2048;
    const payload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    payload.copy(pool, offset);
    const slice = pool.subarray(offset, offset + payload.length);

    expect(slice.byteOffset).toBe(offset);
    expect(Buffer.compare(slice, payload)).toBe(0);

    // The buggy pattern: view the whole backing ArrayBuffer from offset 0.
    const buggyView = new Uint8ClampedArray(slice.buffer);
    expect(buggyView.length).not.toBe(payload.length);
    expect(Array.from(buggyView.slice(0, payload.length))).not.toEqual(Array.from(payload));

    // The fixed pattern: honor byteOffset/byteLength.
    const correctView = new Uint8ClampedArray(slice.buffer, slice.byteOffset, slice.byteLength);
    expect(correctView.length).toBe(payload.length);
    expect(Array.from(correctView)).toEqual(Array.from(payload));
  });
});

describe('optimizeImage — jsquash raw pixel buffer handling (regression for #100)', () => {
  test('PNG round-trip via jsquash preserves exact pixel data across many small encodes', async () => {
    // Small, per-iteration raw buffers are the allocation pattern most likely
    // to land as a sliced view into a pooled ArrayBuffer at a non-zero
    // byteOffset — the exact condition the bug report describes as
    // "allocation-timing dependent... mid-bulk-run". Looping increases the
    // odds of exercising that path while asserting the correctness contract
    // unconditionally, regardless of whether it's hit on a given run.
    const sharp = await sharpLib();
    const width = 12;
    const height = 12;

    for (let iter = 0; iter < 25; iter++) {
      // Distinct, position-dependent color per pixel so any misread byte
      // offset would visibly corrupt the decoded result.
      const raw = Buffer.alloc(width * height * 3);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 3;
          raw[idx] = (x * 17 + iter) & 0xff;
          raw[idx + 1] = (y * 23 + iter) & 0xff;
          raw[idx + 2] = ((x + y) * 11 + iter) & 0xff;
        }
      }
      const sourcePng = await sharp(raw, { raw: { width, height, channels: 3 } })
        .png()
        .toBuffer();

      const result = await optimizeImage(sourcePng, 'image/png', { encoder: 'jsquash' });
      expect(result.after.width).toBe(width);
      expect(result.after.height).toBe(height);

      // OxiPNG is a lossless recompressor — decoded pixels must match the
      // source exactly. Any offset-0 misread would corrupt this.
      const decoded = await sharp(result.bytes)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const expectedRgba = await sharp(raw, { raw: { width, height, channels: 3 } })
        .ensureAlpha()
        .raw()
        .toBuffer();

      expect(decoded.data.length).toBe(expectedRgba.length);
      expect(Buffer.compare(decoded.data, expectedRgba)).toBe(0);
    }
  });

  test('JPEG round-trip via jsquash produces correctly-sized, non-garbage output', async () => {
    const sharp = await sharpLib();
    const width = 16;
    const height = 16;
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < raw.length; i += 3) {
      raw[i] = 200; // solid, distinctive red block
      raw[i + 1] = 40;
      raw[i + 2] = 40;
    }
    const sourceJpeg = await sharp(raw, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer();

    const result = await optimizeImage(sourceJpeg, 'image/jpeg', { encoder: 'jsquash' });
    expect(result.after.width).toBe(width);
    expect(result.after.height).toBe(height);

    const decoded = await sharp(result.bytes).raw().toBuffer({ resolveWithObject: true });
    // Garbage heap data would not average anywhere near the source's solid
    // red block; a correct decode stays close after mozjpeg compression.
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    const pixelCount = decoded.info.width * decoded.info.height;
    for (let i = 0; i < decoded.data.length; i += decoded.info.channels) {
      rSum += decoded.data[i];
      gSum += decoded.data[i + 1];
      bSum += decoded.data[i + 2];
    }
    expect(rSum / pixelCount).toBeGreaterThan(150);
    expect(gSum / pixelCount).toBeLessThan(100);
    expect(bSum / pixelCount).toBeLessThan(100);
  });
});
