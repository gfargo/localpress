/**
 * Engine-layer types for image processing.
 *
 * The engine is intentionally framework-agnostic — it doesn't know about
 * WordPress or the CLI. It takes bytes, returns bytes, and reports stats.
 */

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'gif';

export interface ImageInfo {
  format: ImageFormat;
  width: number;
  height: number;
  sizeBytes: number;
  hasAlpha: boolean;
}

/** Lossy/lossless mode hint. Each codec interprets quality on its own scale. */
export type CompressionMode = 'lossy' | 'lossless';

export interface OptimizeOptions {
  /** Target format. Use the source format if omitted. */
  toFormat?: ImageFormat;
  /** Compression mode. */
  mode?: CompressionMode;
  /** 0–100 quality value (codec-specific interpretation). */
  quality?: number;
  /** Strip EXIF/metadata. Default true (smaller files, privacy-preserving). */
  stripMetadata?: boolean;
  /** Resize: max width in pixels. Aspect ratio preserved. */
  maxWidth?: number;
  /** Resize: max height in pixels. */
  maxHeight?: number;
  /** Encoder backend: 'sharp' (default) or 'jsquash' (WASM codecs). */
  encoder?: 'sharp' | 'jsquash';
}

export interface OptimizeResult {
  /** Resulting image bytes. */
  bytes: Buffer;
  /** Stats describing what changed. */
  before: ImageInfo;
  after: ImageInfo;
  /** Bytes saved (negative if the result grew). */
  savedBytes: number;
  /** Percentage reduction (0-1). Negative if the result grew. */
  savedRatio: number;
  /** Codec/transforms applied, for debugging. */
  appliedSteps: string[];
}
