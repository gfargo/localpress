/**
 * jSquash WASM codec integration.
 *
 * Provides an alternative encoding path using the Squoosh-derived WASM codecs.
 * The main advantage over sharp's built-in encoders:
 *   - OxiPNG for significantly better lossless PNG compression
 *   - MozJPEG with full parameter control
 *   - Consistent cross-platform output (WASM, no native binaries)
 *
 * The jSquash codecs work with ImageData (raw RGBA pixel buffers), so we
 * use sharp for decoding/transforms and jSquash for the final encoding step.
 *
 * All codecs are lazy-loaded so they don't affect CLI boot time.
 */

import type { ImageFormat } from './types.ts';

/**
 * Encode raw pixel data using a jSquash WASM codec.
 */
export async function jsquashEncode(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  format: ImageFormat,
  quality: number,
): Promise<{ bytes: Buffer; codec: string }> {
  // Construct an ImageData-like object for jSquash.
  const imageData = {
    data: pixels,
    width,
    height,
    colorSpace: 'srgb' as const,
  };

  switch (format) {
    case 'jpeg': {
      const jpegMod = await import('@jsquash/jpeg');
      const result = (await jpegMod.encode(imageData, { quality })) as ArrayBuffer;
      return { bytes: Buffer.from(result), codec: 'jsquash/mozjpeg' };
    }

    case 'png': {
      const pngMod = await import('@jsquash/png');
      const pngBuffer = (await pngMod.encode(imageData)) as ArrayBuffer;

      try {
        const oxipngMod = await import('@jsquash/oxipng');
        const optimized = (await oxipngMod.optimise(pngBuffer, { level: 3 })) as ArrayBuffer;
        return { bytes: Buffer.from(optimized), codec: 'jsquash/oxipng' };
      } catch {
        // OxiPNG failed; return the basic PNG.
        return { bytes: Buffer.from(pngBuffer), codec: 'jsquash/png' };
      }
    }

    case 'webp': {
      const webpMod = await import('@jsquash/webp');
      const result = (await webpMod.encode(imageData, { quality })) as ArrayBuffer;
      return { bytes: Buffer.from(result), codec: 'jsquash/webp' };
    }

    case 'avif': {
      const avifMod = await import('@jsquash/avif');
      const result = (await avifMod.encode(imageData, {
        quality,
        speed: 6,
      })) as ArrayBuffer;
      return { bytes: Buffer.from(result), codec: 'jsquash/avif' };
    }

    default:
      throw new Error(
        `jSquash encoder does not support format '${format}'. Supported: jpeg, png, webp, avif. Use --encoder sharp for other formats.`,
      );
  }
}

/**
 * Check if a format is supported by the jSquash encoder.
 */
export function isJsquashSupported(format: ImageFormat): boolean {
  return ['jpeg', 'png', 'webp', 'avif'].includes(format);
}
