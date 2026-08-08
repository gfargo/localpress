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

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { simd, threads } from 'wasm-feature-detect';
import type { ImageFormat } from './types.ts';

const require = createRequire(import.meta.url);

/**
 * Read a `.wasm` file's bytes off disk. jSquash's emscripten codecs are built
 * for `-sENVIRONMENT=web,worker`; their only non-throwing load path is
 * `WebAssembly.instantiateStreaming`, which Bun doesn't implement. Feeding
 * `wasmBinary` directly via `init()` bypasses that path entirely — emscripten
 * only reaches for streaming fetch when `wasmBinary` is unset.
 */
async function loadWasmBinary(specifier: string): Promise<ArrayBuffer> {
  const buf = await readFile(require.resolve(specifier));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

let jpegReady: Promise<void> | undefined;
async function ensureJpeg(): Promise<void> {
  if (!jpegReady) {
    jpegReady = (async () => {
      const [{ init }, wasmBinary] = await Promise.all([
        import('@jsquash/jpeg/encode'),
        loadWasmBinary('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm'),
      ]);
      await init({ wasmBinary });
    })();
  }
  await jpegReady;
}

let webpReady: Promise<void> | undefined;
async function ensureWebp(): Promise<void> {
  if (!webpReady) {
    webpReady = (async () => {
      const [{ init }, useSimd] = await Promise.all([import('@jsquash/webp/encode'), simd()]);
      const wasmBinary = await loadWasmBinary(
        useSimd
          ? '@jsquash/webp/codec/enc/webp_enc_simd.wasm'
          : '@jsquash/webp/codec/enc/webp_enc.wasm',
      );
      await init({ wasmBinary });
    })();
  }
  await webpReady;
}

let avifReady: Promise<void> | undefined;
async function ensureAvif(): Promise<void> {
  if (!avifReady) {
    avifReady = (async () => {
      // Mirrors @jsquash/avif/encode.js's own selection logic so the WASM
      // bytes we preload match the variant its glue expects to import.
      const isRunningInNode =
        typeof process !== 'undefined' && !!process.release && process.release.name === 'node';
      const isRunningInCloudflareWorker =
        (globalThis as { caches?: { default?: unknown } }).caches?.default !== undefined;
      const useMultiThread = !isRunningInNode && !isRunningInCloudflareWorker && (await threads());

      const [{ init }, wasmBinary] = await Promise.all([
        import('@jsquash/avif/encode'),
        loadWasmBinary(
          useMultiThread
            ? '@jsquash/avif/codec/enc/avif_enc_mt.wasm'
            : '@jsquash/avif/codec/enc/avif_enc.wasm',
        ),
      ]);
      await init({ wasmBinary });
    })();
  }
  await avifReady;
}

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
      await ensureJpeg();
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
      await ensureWebp();
      const webpMod = await import('@jsquash/webp');
      const result = (await webpMod.encode(imageData, { quality })) as ArrayBuffer;
      return { bytes: Buffer.from(result), codec: 'jsquash/webp' };
    }

    case 'avif': {
      await ensureAvif();
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

export interface EncoderPreflightResult {
  ok: boolean;
  formats: Array<{ format: ImageFormat; ok: boolean; codec?: string; error?: string }>;
  firstError?: { format: ImageFormat; error: string };
}

/** A tiny 2x2 opaque RGBA buffer — just enough to exercise a codec's load/encode path. */
const PREFLIGHT_PIXELS = new Uint8ClampedArray([
  255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
]);

/**
 * Attempt a tiny real encode for each requested format to confirm the jSquash
 * WASM codec actually loads and produces output. This is a one-time check
 * meant to run before a bulk `optimize --encoder jsquash` run touches
 * anything — a codec that fails to load today throws per-item, mid-run.
 */
export async function preflightJsquashEncoder(
  formats: ImageFormat[],
): Promise<EncoderPreflightResult> {
  const results: EncoderPreflightResult['formats'] = [];
  let firstError: EncoderPreflightResult['firstError'];

  for (const format of formats) {
    if (!isJsquashSupported(format)) continue;
    try {
      const { codec } = await jsquashEncode(PREFLIGHT_PIXELS, 2, 2, format, 75);
      results.push({ format, ok: true, codec });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ format, ok: false, error: message });
      if (!firstError) firstError = { format, error: message };
    }
  }

  return {
    ok: results.every((r) => r.ok),
    formats: results,
    firstError,
  };
}
