/**
 * Image optimization engine.
 *
 * Uses sharp (libvips) as the primary processing pipeline for transforms
 * (resize, rotate, metadata strip) and encoding. Sharp's built-in encoders
 * cover jpeg (mozjpeg), png, webp, and avif with good quality.
 *
 * The @jsquash/* WASM codecs are available as an alternative encoding path
 * for cases where Squoosh-level quality tuning is needed. For v0.1, sharp
 * handles everything; jsquash integration is a v0.5 enhancement for users
 * who want finer codec control.
 *
 * This module is framework-agnostic — it takes bytes, returns bytes, and
 * reports stats. It doesn't know about WordPress or the CLI.
 */

import { isJsquashSupported, jsquashEncode } from './jsquash.ts';
import type {
  CompressionMode,
  ImageFormat,
  ImageInfo,
  OptimizeOptions,
  OptimizeResult,
} from './types.ts';

/**
 * Optimize an image buffer according to the given options.
 *
 * Returns the optimized bytes along with before/after stats.
 */
export async function optimizeImage(
  sourceBytes: Buffer,
  sourceMimeType: string,
  opts: OptimizeOptions = {},
): Promise<OptimizeResult> {
  // Lazy-load sharp so the CLI boots even if sharp's platform binary is missing.
  // biome-ignore lint/suspicious/noExplicitAny: sharp's type export is complex
  let sharp: any;
  try {
    const mod = await import('sharp');
    sharp = mod.default;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Cannot find package') || msg.includes('MODULE_NOT_FOUND')) {
      throw new Error(
        'sharp is not installed. Image processing requires sharp.\n\n' +
          'Install it with:\n' +
          '  npm install -g sharp\n' +
          '  # or, if using Bun:\n' +
          '  bun install -g sharp\n\n' +
          'If you installed localpress via Homebrew, run:\n' +
          '  brew install vips && npm install -g sharp\n\n' +
          'See: https://sharp.pixelplumbing.com/install',
      );
    }
    throw err;
  }

  // Probe the source image for metadata.
  const metadata = await sharp(sourceBytes).metadata();
  const before: ImageInfo = {
    format: mimeToFormat(sourceMimeType) ?? (metadata.format as ImageFormat) ?? 'jpeg',
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    sizeBytes: sourceBytes.length,
    hasAlpha: metadata.hasAlpha ?? false,
  };

  let pipeline = sharp(sourceBytes);
  const appliedSteps: string[] = [];

  // Resize if requested.
  if (opts.maxWidth || opts.maxHeight) {
    pipeline = pipeline.resize({
      width: opts.maxWidth,
      height: opts.maxHeight,
      fit: 'inside',
      withoutEnlargement: true,
    });
    appliedSteps.push(`resize(${opts.maxWidth ?? 'auto'}×${opts.maxHeight ?? 'auto'})`);
  }

  // Auto-rotate based on EXIF orientation, then strip metadata.
  if (opts.stripMetadata !== false) {
    pipeline = pipeline.rotate();
    appliedSteps.push('auto-rotate');
    appliedSteps.push('strip-metadata');
  }

  // Determine output format and quality.
  const targetFormat = opts.toFormat ?? before.format;
  const mode: CompressionMode = opts.mode ?? defaultMode(targetFormat);
  const quality = opts.quality ?? defaultQuality(targetFormat, mode);

  // Choose encoding path: jsquash WASM codecs or sharp built-in.
  const useJsquash = opts.encoder === 'jsquash' && isJsquashSupported(targetFormat);

  let outputBuffer: Buffer;

  if (useJsquash) {
    // Use sharp for transforms (resize, rotate, strip) then extract raw pixels
    // for jSquash encoding.
    const rawBuffer = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixels = new Uint8ClampedArray(rawBuffer.data.buffer);

    const jsResult = await jsquashEncode(
      pixels,
      rawBuffer.info.width,
      rawBuffer.info.height,
      targetFormat,
      quality,
    );
    outputBuffer = jsResult.bytes;
    appliedSteps.push(jsResult.codec);
  } else {
    // Apply format-specific encoding via sharp.
    switch (targetFormat) {
      case 'jpeg':
        pipeline = pipeline.jpeg({ quality, mozjpeg: true });
        appliedSteps.push(`jpeg(q=${quality}, mozjpeg)`);
        break;
      case 'png':
        pipeline = pipeline.png({ compressionLevel: 9, effort: 10 });
        appliedSteps.push('png(level=9, effort=10)');
        break;
      case 'webp':
        pipeline = pipeline.webp({
          quality,
          effort: 6,
          lossless: mode === 'lossless',
        });
        appliedSteps.push(`webp(q=${quality}, ${mode}, effort=6)`);
        break;
      case 'avif':
        pipeline = pipeline.avif({
          quality,
          effort: 6,
          lossless: mode === 'lossless',
        });
        appliedSteps.push(`avif(q=${quality}, ${mode}, effort=6)`);
        break;
      case 'gif':
        pipeline = pipeline.gif();
        appliedSteps.push('gif(passthrough)');
        break;
      default:
        appliedSteps.push(`passthrough(${targetFormat})`);
        break;
    }

    outputBuffer = await pipeline.toBuffer();
  }

  const outputMetadata = await sharp(outputBuffer).metadata();

  const after: ImageInfo = {
    format: targetFormat,
    width: outputMetadata.width ?? before.width,
    height: outputMetadata.height ?? before.height,
    sizeBytes: outputBuffer.length,
    hasAlpha: outputMetadata.hasAlpha ?? before.hasAlpha,
  };

  const savedBytes = before.sizeBytes - after.sizeBytes;
  const savedRatio = before.sizeBytes > 0 ? savedBytes / before.sizeBytes : 0;

  return {
    bytes: outputBuffer,
    before,
    after,
    savedBytes,
    savedRatio,
    appliedSteps,
  };
}

// -- Helpers ------------------------------------------------------------------

export function mimeToFormat(mimeType: string): ImageFormat | undefined {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpeg';
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('avif')) return 'avif';
  if (mimeType.includes('gif')) return 'gif';
  return undefined;
}

function defaultMode(format: ImageFormat): CompressionMode {
  // PNG is lossless by nature; everything else defaults to lossy.
  return format === 'png' ? 'lossless' : 'lossy';
}

function defaultQuality(format: ImageFormat, mode: CompressionMode): number {
  if (mode === 'lossless') return 100;
  switch (format) {
    case 'jpeg':
      return 80;
    case 'webp':
      return 80;
    case 'avif':
      return 65; // AVIF is more efficient; lower quality = same perceptual result.
    default:
      return 80;
  }
}
