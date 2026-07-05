/**
 * Unit tests for the image-engine safety guards added in the trust release:
 *   - SVG / unencodable formats throw instead of silently rasterizing to PNG.
 *   - Animated sources are preserved for gif/webp and refused for jpeg/png/avif.
 *   - PNG transparency is flattened (not turned black) when converting to JPEG.
 *   - EXIF orientation is baked in even when metadata is kept.
 */

import { describe, expect, test } from 'bun:test';
import { OPTIMIZABLE_MIME_TYPES, isOptimizableMime } from '../../src/cli/commands/optimize.ts';
import {
  AnimatedImageError,
  UnsupportedFormatError,
  optimizeImage,
} from '../../src/engine/image/optimize.ts';

async function sharpLib() {
  return (await import('sharp')).default;
}

/** Build a tiny 2-frame animated GIF. */
async function makeAnimatedGif(): Promise<Buffer> {
  const sharp = await sharpLib();
  const width = 8;
  const height = 8;
  const channels = 4;
  const frame = (v: number) => {
    const buf = Buffer.alloc(width * height * channels);
    for (let i = 0; i < buf.length; i += channels) {
      buf[i] = v;
      buf[i + 1] = v;
      buf[i + 2] = v;
      buf[i + 3] = 255;
    }
    return buf;
  };
  const two = Buffer.concat([frame(0), frame(255)]);
  return sharp(two, {
    raw: { width, height: height * 2, channels },
    animated: true,
    pageHeight: height,
    // biome-ignore lint/suspicious/noExplicitAny: pageHeight isn't in sharp's raw types
  } as any)
    .gif()
    .toBuffer();
}

// Some libvips builds ship without GIF/WebP animation (no cgif). The animation
// guards only matter — and are only testable — where multi-frame is supported,
// so probe once and skip those cases gracefully elsewhere.
async function detectAnimationSupport(): Promise<boolean> {
  try {
    const sharp = await sharpLib();
    const gif = await makeAnimatedGif();
    return ((await sharp(gif).metadata()).pages ?? 1) > 1;
  } catch {
    return false;
  }
}
const ANIMATION_SUPPORTED = await detectAnimationSupport();

describe('optimizeImage — format guards', () => {
  test('SVG source throws UnsupportedFormatError instead of rasterizing', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>',
    );
    // Force the target format to svg (the real bulk path never gets here because
    // the command whitelist filters SVG out first — this is defense in depth).
    await expect(
      optimizeImage(svg, 'image/svg+xml', { toFormat: 'svg' as never }),
    ).rejects.toBeInstanceOf(UnsupportedFormatError);
  });
});

describe('OPTIMIZABLE_MIME_TYPES — bulk-path whitelist', () => {
  test('excludes SVG and other non-raster types', () => {
    expect(isOptimizableMime('image/svg+xml')).toBe(false);
    expect(isOptimizableMime('image/x-icon')).toBe(false);
    expect(isOptimizableMime('application/pdf')).toBe(false);
    expect(isOptimizableMime(undefined)).toBe(false);
  });

  test('includes all supported raster types', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']) {
      expect(OPTIMIZABLE_MIME_TYPES.has(mime)).toBe(true);
      expect(isOptimizableMime(mime)).toBe(true);
    }
  });
});

describe('optimizeImage — animation handling', () => {
  test.skipIf(!ANIMATION_SUPPORTED)(
    'animated GIF stays animated through same-format optimize',
    async () => {
      const sharp = await sharpLib();
      const gif = await makeAnimatedGif();
      expect((await sharp(gif).metadata()).pages).toBeGreaterThan(1);

      const result = await optimizeImage(gif, 'image/gif', {});
      const outPages = (await sharp(result.bytes).metadata()).pages ?? 1;
      expect(outPages).toBeGreaterThan(1);
    },
  );

  test.skipIf(!ANIMATION_SUPPORTED)(
    'animated GIF is preserved when converting to WebP',
    async () => {
      const sharp = await sharpLib();
      const gif = await makeAnimatedGif();
      const result = await optimizeImage(gif, 'image/gif', { toFormat: 'webp' });
      const outPages = (await sharp(result.bytes).metadata()).pages ?? 1;
      expect(outPages).toBeGreaterThan(1);
    },
  );

  test.skipIf(!ANIMATION_SUPPORTED)(
    'animated GIF → JPEG throws AnimatedImageError (would lose animation)',
    async () => {
      const gif = await makeAnimatedGif();
      await expect(optimizeImage(gif, 'image/gif', { toFormat: 'jpeg' })).rejects.toBeInstanceOf(
        AnimatedImageError,
      );
    },
  );
});

describe('optimizeImage — fidelity', () => {
  test('transparent PNG → JPEG flattens transparency to white, not black', async () => {
    const sharp = await sharpLib();
    // A fully transparent 16x16 image.
    const transparent = await sharp({
      create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();

    const result = await optimizeImage(transparent, 'image/png', { toFormat: 'jpeg' });
    const { data } = await sharp(result.bytes).raw().toBuffer({ resolveWithObject: true });
    // Center pixel should be white (flattened), not black.
    expect(data[0]).toBeGreaterThan(240);
    expect(data[1]).toBeGreaterThan(240);
    expect(data[2]).toBeGreaterThan(240);
  });

  test('EXIF orientation is baked in even when metadata is kept', async () => {
    const sharp = await sharpLib();
    // 20x10 landscape image tagged orientation 6 (rotate 90° CW on display →
    // renders as 10x20 portrait). After optimize the pixels must be upright.
    const tagged = await sharp({
      create: { width: 20, height: 10, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const result = await optimizeImage(tagged, 'image/jpeg', { stripMetadata: false });
    const meta = await sharp(result.bytes).metadata();
    // Pixels are physically rotated to portrait; no residual orientation flag.
    expect(meta.width).toBe(10);
    expect(meta.height).toBe(20);
    expect(meta.orientation ?? 1).toBe(1);
  });
});
