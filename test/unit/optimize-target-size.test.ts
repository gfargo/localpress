/**
 * Unit tests for the --target-size / binary-search quality feature.
 *
 * Tests use sharp (which is installed as a dev dep) to produce real encoded
 * output so we can verify the binary search actually converges.
 */

import { describe, expect, test } from 'bun:test';

import { optimizeImage } from '../../src/engine/image/optimize.ts';

describe('optimizeImage — targetSizeBytes binary search', () => {
  test('result fits within target size for jpeg', async () => {
    // Use a high-entropy image so the JPEG encoder has real content to compress.
    // Solid-colour images are already near the minimum JPEG file size even at q=1
    // (mostly headers), leaving no headroom for the binary search to hit 50%.
    const sharp = (await import('sharp')).default;
    const width = 200;
    const height = 200;
    const channels = 3;
    const rawBuffer = Buffer.alloc(width * height * channels);
    for (let i = 0; i < rawBuffer.length; i++) {
      // Deterministic pseudo-random pattern — high spatial frequency = large JPEG.
      rawBuffer[i] = (i * 127 + (i >> 3) * 31) & 0xff;
    }
    const sourceBytes = await sharp(rawBuffer, { raw: { width, height, channels } })
      .jpeg({ quality: 95 })
      .toBuffer();

    const targetBytes = Math.round(sourceBytes.length * 0.5); // aim for 50% of source

    const result = await optimizeImage(sourceBytes, 'image/jpeg', {
      targetSizeBytes: targetBytes,
    });

    expect(result.after.sizeBytes).toBeLessThanOrEqual(targetBytes);
    expect(result.finalQuality).toBeNumber();
    expect(result.finalQuality).toBeGreaterThanOrEqual(1);
    expect(result.finalQuality).toBeLessThanOrEqual(100);
  });

  test('result fits within target size for webp', async () => {
    const sharp = (await import('sharp')).default;
    const sourceBytes = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 200, g: 80, b: 50 } },
    })
      .jpeg({ quality: 95 })
      .toBuffer();

    const targetBytes = Math.round(sourceBytes.length * 0.6);

    const result = await optimizeImage(sourceBytes, 'image/jpeg', {
      toFormat: 'webp',
      targetSizeBytes: targetBytes,
    });

    expect(result.after.sizeBytes).toBeLessThanOrEqual(targetBytes);
    expect(result.finalQuality).toBeNumber();
  });

  test('higher quality is preferred when both fit', async () => {
    // When target is generous, the binary search should converge to a higher quality
    // than the minimum needed, because it searches for the highest quality that fits.
    const sharp = (await import('sharp')).default;
    const sourceBytes = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 50, g: 100, b: 150 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    // Very generous target (2× the source size) — should land near high quality.
    const result = await optimizeImage(sourceBytes, 'image/jpeg', {
      targetSizeBytes: sourceBytes.length * 2,
    });

    // With a very generous target the binary search should converge near q=100.
    expect(result.finalQuality).toBeGreaterThan(50);
  });

  test('uses quality=1 when target is impossible to meet', async () => {
    const sharp = (await import('sharp')).default;
    const sourceBytes = await sharp({
      create: { width: 50, height: 50, channels: 3, background: { r: 128, g: 128, b: 128 } },
    })
      .jpeg({ quality: 80 })
      .toBuffer();

    // Target of 1 byte — impossible. Engine should use q=1 (best effort).
    const result = await optimizeImage(sourceBytes, 'image/jpeg', {
      targetSizeBytes: 1,
    });

    expect(result.finalQuality).toBe(1);
  });

  test('png ignores targetSizeBytes (no quality knob)', async () => {
    const sharp = (await import('sharp')).default;
    const sourceBytes = await sharp({
      create: { width: 50, height: 50, channels: 3, background: { r: 0, g: 255, b: 0 } },
    })
      .png()
      .toBuffer();

    const result = await optimizeImage(sourceBytes, 'image/png', {
      toFormat: 'png',
      targetSizeBytes: 1, // impossible — but PNG has no quality knob so it's ignored
    });

    // finalQuality is undefined for PNG.
    expect(result.finalQuality).toBeUndefined();
    // Result should still be valid PNG bytes.
    expect(result.after.format).toBe('png');
    expect(result.bytes.length).toBeGreaterThan(0);
  });

  test('finalQuality is set on normal (non-target-size) jpeg encode', async () => {
    const sharp = (await import('sharp')).default;
    const sourceBytes = await sharp({
      create: { width: 50, height: 50, channels: 3, background: { r: 200, g: 200, b: 200 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    const result = await optimizeImage(sourceBytes, 'image/jpeg', { quality: 75 });
    expect(result.finalQuality).toBe(75);
  });
});
