/**
 * Unit tests for the --target-size / binary-search quality feature.
 *
 * Tests use sharp (which is installed as a dev dep) to produce real encoded
 * output so we can verify the binary search actually converges.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { optimizeImage } from '../../src/engine/image/optimize.ts';

// Minimal 10×10 JPEG fixture encoded inline to avoid filesystem fixtures.
// Created with: sharp({ create: { width: 10, height: 10, channels: 3, background: {r:100,g:150,b:200} } }).jpeg({quality:80}).toBuffer()
// Stored as a base64 string so the test file is self-contained.
const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof' +
  'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwh' +
  'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAAR' +
  'CAAKAAoDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABgUE/8QAIxAAAQQCAgMBAAAAAA' +
  'AAAAAAAQIDBAUGESERITH/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAA' +
  'AAAAA/9oADAMBAAIRAxEAPwCw3nku1ZjZ7ZmMGvF1BdFaMQRDlFmGWqNRCCGsjlMgYBvGwAA' +
  'AAAAAAAAAAAAAAf/2Q==';

function tinyJpegBuffer(): Buffer {
  return Buffer.from(TINY_JPEG_B64, 'base64');
}

describe('optimizeImage — targetSizeBytes binary search', () => {
  test('result fits within target size for jpeg', async () => {
    // Use a larger JPEG so there is room to compress.
    // Generate a 200×200 solid-colour JPEG (≈ a few KB) via sharp.
    const sharp = (await import('sharp')).default;
    const sourceBytes = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 100, g: 150, b: 200 } },
    })
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
