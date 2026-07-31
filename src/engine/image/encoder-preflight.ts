/**
 * Pure decision helpers for the jSquash encoder pre-flight (localpress#293).
 *
 * Kept separate from `jsquash.ts` (which does the actual WASM codec work) so
 * the format-selection and strict/fallback logic can be unit tested without
 * mocking dynamic codec imports.
 */

import { isJsquashSupported } from './jsquash.ts';
import type { ImageFormat, OptimizeOptions } from './types.ts';

/** All formats the jSquash pre-flight would need to cover when no explicit target format is set. */
export const ALL_JSQUASH_FORMATS: ImageFormat[] = ['jpeg', 'png', 'webp', 'avif'];

/**
 * Determine which formats the jSquash pre-flight should cover for a given
 * optimize run: just the resolved target format if one was requested (and
 * it's a jSquash-supported format), otherwise every jSquash-supported format
 * (to cover per-item smart format defaults and source-format passthrough).
 */
export function selectPreflightFormats(
  optimizeOpts: Pick<OptimizeOptions, 'toFormat'>,
): ImageFormat[] {
  if (optimizeOpts.toFormat) {
    return isJsquashSupported(optimizeOpts.toFormat) ? [optimizeOpts.toFormat] : [];
  }
  return ALL_JSQUASH_FORMATS;
}

export type EncoderPreflightAction = 'proceed' | 'fallback' | 'abort';

/**
 * Decide what to do after running the jSquash pre-flight: proceed unchanged
 * if it succeeded, otherwise either abort (--strict) or fall back to sharp.
 */
export function resolveEncoderAfterPreflight(args: {
  preflightOk: boolean;
  strict: boolean;
}): { action: EncoderPreflightAction } {
  if (args.preflightOk) return { action: 'proceed' };
  return { action: args.strict ? 'abort' : 'fallback' };
}
