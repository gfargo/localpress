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
import { loadSharp } from './sharp-loader.ts';
import type {
  CompressionMode,
  ImageFormat,
  ImageInfo,
  OptimizeOptions,
  OptimizeResult,
} from './types.ts';

/** Formats the engine can actually encode. Anything else (e.g. svg) must not
 * be silently rasterized — sharp would emit PNG bytes under the wrong label. */
const ENCODABLE_FORMATS: readonly ImageFormat[] = ['jpeg', 'png', 'webp', 'avif', 'gif'];

/** Formats that can hold multi-frame animation. */
const ANIMATION_CAPABLE_FORMATS: readonly ImageFormat[] = ['gif', 'webp'];

/**
 * Thrown when the requested output format is not one the engine can encode
 * (e.g. SVG). Callers should skip the item rather than corrupt it.
 */
export class UnsupportedFormatError extends Error {
  constructor(public readonly format: string) {
    super(`Unsupported image format: ${format}`);
    this.name = 'UnsupportedFormatError';
  }
}

/**
 * Thrown when an animated source would be flattened by converting to a format
 * that cannot preserve animation (jpeg/png/avif). Callers should skip and warn.
 */
export class AnimatedImageError extends Error {
  constructor(
    public readonly sourceFormat: string,
    public readonly targetFormat: string,
  ) {
    super(`Cannot convert animated ${sourceFormat} to ${targetFormat} without losing animation`);
    this.name = 'AnimatedImageError';
  }
}

/**
 * Optimize an image buffer according to the given options.
 *
 * Returns the optimized bytes along with before/after stats.
 * When `opts.targetSizeBytes` is set for a lossy format, binary-searches the
 * quality parameter (1–100) to produce a result ≤ that size.
 */
export async function optimizeImage(
  sourceBytes: Buffer,
  sourceMimeType: string,
  opts: OptimizeOptions = {},
): Promise<OptimizeResult> {
  // Lazy-load sharp (native or WASM fallback) so the CLI boots fast.
  // biome-ignore lint/suspicious/noExplicitAny: sharp type varies by version
  const sharp: any = await loadSharp();

  // Probe the source image for metadata.
  const metadata = await sharp(sourceBytes).metadata();
  const isAnimated = (metadata.pages ?? 1) > 1;
  const before: ImageInfo = {
    format: mimeToFormat(sourceMimeType) ?? (metadata.format as ImageFormat) ?? 'jpeg',
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    sizeBytes: sourceBytes.length,
    hasAlpha: metadata.hasAlpha ?? false,
  };

  const targetFormat = opts.toFormat ?? before.format;

  // Guard: never silently rasterize an unencodable format (e.g. svg → png bytes).
  if (!ENCODABLE_FORMATS.includes(targetFormat)) {
    throw new UnsupportedFormatError(targetFormat);
  }

  // Guard: don't flatten animation into a single frame. Preserve it where the
  // target can hold it; otherwise refuse so the caller can skip and warn.
  if (isAnimated && !ANIMATION_CAPABLE_FORMATS.includes(targetFormat)) {
    throw new AnimatedImageError(before.format, targetFormat);
  }

  const mode: CompressionMode = opts.mode ?? defaultMode(targetFormat);
  const supportsQualityTuning =
    targetFormat === 'jpeg' || targetFormat === 'webp' || targetFormat === 'avif';

  let outputBuffer: Buffer;
  let appliedSteps: string[];
  let finalQuality: number | undefined;

  // Lossless formats don't respond to the quality knob, so a target-size
  // binary search would just burn encodes and return an oversized result.
  const canSearchTargetSize = supportsQualityTuning && mode !== 'lossless';

  if (opts.targetSizeBytes && canSearchTargetSize) {
    // Binary-search quality to hit the target file size.
    const result = await binarySearchQuality(
      sharp,
      sourceBytes,
      opts,
      targetFormat,
      mode,
      isAnimated,
      opts.targetSizeBytes,
    );
    outputBuffer = result.bytes;
    appliedSteps = result.steps;
    finalQuality = result.quality;
  } else {
    // Normal single-pass encoding.
    const quality = opts.quality ?? defaultQuality(targetFormat, mode);
    const result = await encodeImage(
      sharp,
      sourceBytes,
      opts,
      targetFormat,
      mode,
      isAnimated,
      quality,
    );
    outputBuffer = result.bytes;
    appliedSteps = result.steps;
    finalQuality = supportsQualityTuning ? quality : undefined;
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
    finalQuality,
  };
}

// -- Internal helpers ---------------------------------------------------------

/**
 * Apply transforms (resize, auto-rotate, strip metadata) and encode at a
 * specific quality value.  Called once per binary-search iteration.
 */
async function encodeImage(
  // biome-ignore lint/suspicious/noExplicitAny: sharp pipeline is untyped
  sharp: any,
  sourceBytes: Buffer,
  opts: OptimizeOptions,
  targetFormat: ImageFormat,
  mode: CompressionMode,
  animated: boolean,
  quality: number,
): Promise<{ bytes: Buffer; steps: string[] }> {
  // Decode every frame when the source is animated so multi-frame output
  // (gif/webp) preserves the animation instead of keeping only frame 1.
  let pipeline = animated ? sharp(sourceBytes, { animated: true }) : sharp(sourceBytes);
  const steps: string[] = [];

  // Always auto-rotate based on EXIF orientation so pixels are stored upright.
  // (Doing this unconditionally fixes sideways photos when metadata is kept.)
  pipeline = pipeline.rotate();
  steps.push('auto-rotate');

  // Resize if requested (after rotate, so max-width applies to the upright image).
  if (opts.maxWidth || opts.maxHeight) {
    pipeline = pipeline.resize({
      width: opts.maxWidth,
      height: opts.maxHeight,
      fit: 'inside',
      withoutEnlargement: true,
    });
    steps.push(`resize(${opts.maxWidth ?? 'auto'}×${opts.maxHeight ?? 'auto'})`);
  }

  // Sharp strips metadata by default. When the caller explicitly asks to keep
  // it, preserve it (orientation is already baked into pixels by .rotate()).
  if (opts.stripMetadata === false) {
    pipeline = pipeline.keepMetadata();
    steps.push('keep-metadata');
  } else {
    steps.push('strip-metadata');
  }

  // Choose encoding path: jsquash WASM codecs or sharp built-in.
  const useJsquash = opts.encoder === 'jsquash' && isJsquashSupported(targetFormat);
  let bytes: Buffer;

  if (useJsquash) {
    // Use sharp for transforms then extract raw pixels for jSquash encoding.
    const rawBuffer = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    // The raw Buffer is frequently a view into a larger pooled ArrayBuffer, so
    // honor byteOffset/byteLength — viewing from offset 0 reads unrelated heap.
    const pixels = new Uint8ClampedArray(
      rawBuffer.data.buffer,
      rawBuffer.data.byteOffset,
      rawBuffer.data.byteLength,
    );
    const expected = rawBuffer.info.width * rawBuffer.info.height * 4;
    if (pixels.length !== expected) {
      throw new Error(
        `jsquash: raw pixel length ${pixels.length} != expected ${expected} (w=${rawBuffer.info.width} h=${rawBuffer.info.height})`,
      );
    }

    const jsResult = await jsquashEncode(
      pixels,
      rawBuffer.info.width,
      rawBuffer.info.height,
      targetFormat,
      quality,
    );
    bytes = jsResult.bytes;
    steps.push(jsResult.codec);
  } else {
    // Apply format-specific encoding via sharp.
    switch (targetFormat) {
      case 'jpeg':
        // JPEG has no alpha; flatten transparency onto white so previously
        // transparent regions don't render as solid black.
        bytes = await pipeline
          .flatten({ background: '#ffffff' })
          .jpeg({ quality, mozjpeg: true })
          .toBuffer();
        steps.push(`jpeg(q=${quality}, mozjpeg, flatten)`);
        break;
      case 'png':
        bytes = await pipeline.png({ compressionLevel: 9, effort: 10 }).toBuffer();
        steps.push('png(level=9, effort=10)');
        break;
      case 'webp':
        bytes = await pipeline
          .webp({ quality, effort: 6, lossless: mode === 'lossless' })
          .toBuffer();
        steps.push(`webp(q=${quality}, ${mode}, effort=6)`);
        break;
      case 'avif':
        bytes = await pipeline
          .avif({ quality, effort: 6, lossless: mode === 'lossless' })
          .toBuffer();
        steps.push(`avif(q=${quality}, ${mode}, effort=6)`);
        break;
      case 'gif':
        bytes = await pipeline.gif().toBuffer();
        steps.push(animated ? 'gif(animated)' : 'gif');
        break;
    }
  }

  return { bytes, steps };
}

/**
 * Binary-search the quality parameter to produce a file ≤ targetSizeBytes.
 *
 * - Up to 8 iterations (each halves the search space).
 * - Stops early when the result is within 5% of the target.
 * - If quality=1 still exceeds the target, returns quality=1 (best effort).
 *
 * The binary search maximises quality while satisfying the size constraint:
 *   - If mid-quality fits → record as best, try higher (lo = mid + 1)
 *   - If mid-quality is too large → try lower (hi = mid - 1)
 */
async function binarySearchQuality(
  // biome-ignore lint/suspicious/noExplicitAny: sharp pipeline is untyped
  sharp: any,
  sourceBytes: Buffer,
  opts: OptimizeOptions,
  targetFormat: ImageFormat,
  mode: CompressionMode,
  animated: boolean,
  targetSizeBytes: number,
  maxIterations = 8,
  tolerance = 0.05,
): Promise<{ bytes: Buffer; quality: number; steps: string[] }> {
  let lo = 1;
  let hi = 100;
  let best: { bytes: Buffer; quality: number; steps: string[] } | null = null;

  for (let i = 0; i < maxIterations && lo <= hi; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = await encodeImage(
      sharp,
      sourceBytes,
      opts,
      targetFormat,
      mode,
      animated,
      mid,
    );

    if (candidate.bytes.length <= targetSizeBytes) {
      best = { bytes: candidate.bytes, quality: mid, steps: candidate.steps };
      // Stop early when within the 5% tolerance band.
      const gap = (targetSizeBytes - candidate.bytes.length) / targetSizeBytes;
      if (gap <= tolerance) break;
      lo = mid + 1; // Try a higher quality next.
    } else {
      hi = mid - 1; // Too large — try lower quality.
    }
  }

  // If no quality satisfied the target, return quality=1 (smallest achievable).
  if (!best) {
    const candidate = await encodeImage(sharp, sourceBytes, opts, targetFormat, mode, animated, 1);
    best = { bytes: candidate.bytes, quality: 1, steps: candidate.steps };
  }

  return best;
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
