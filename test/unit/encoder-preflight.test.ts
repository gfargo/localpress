/**
 * Tests for the jSquash encoder pre-flight (localpress#293 / N-03).
 *
 * `optimize --encoder jsquash` used to have no equivalent to `caption`'s
 * Ollama pre-flight: a codec that failed to load threw per-item, mid-run.
 * These tests cover the real-codec preflight encode, the pure strict/fallback
 * decision, and the format-selection logic that decides what to preflight.
 */

import { describe, expect, test } from 'bun:test';
import {
  ALL_JSQUASH_FORMATS,
  resolveEncoderAfterPreflight,
  selectPreflightFormats,
} from '../../src/engine/image/encoder-preflight.ts';
import { preflightJsquashEncoder } from '../../src/engine/image/jsquash.ts';

describe('preflightJsquashEncoder', () => {
  test('succeeds for the bundled jpeg/png/webp codecs', async () => {
    const result = await preflightJsquashEncoder(['jpeg', 'png', 'webp']);
    expect(result.ok).toBe(true);
    expect(result.firstError).toBeUndefined();
    expect(result.formats).toHaveLength(3);
    for (const f of result.formats) {
      expect(f.ok).toBe(true);
      expect(f.codec).toBeDefined();
    }
  });

  test('succeeds for avif', async () => {
    const result = await preflightJsquashEncoder(['avif']);
    expect(result.ok).toBe(true);
    expect(result.formats[0]?.ok).toBe(true);
  }, 20_000);

  test('skips formats jSquash does not support (defensive filter)', async () => {
    const result = await preflightJsquashEncoder(['gif']);
    expect(result.formats).toHaveLength(0);
    expect(result.ok).toBe(true); // vacuously true — nothing to check
  });
});

describe('resolveEncoderAfterPreflight', () => {
  test('proceeds when the preflight succeeded, regardless of --strict', () => {
    expect(resolveEncoderAfterPreflight({ preflightOk: true, strict: false })).toEqual({
      action: 'proceed',
    });
    expect(resolveEncoderAfterPreflight({ preflightOk: true, strict: true })).toEqual({
      action: 'proceed',
    });
  });

  test('aborts on failure with --strict', () => {
    expect(resolveEncoderAfterPreflight({ preflightOk: false, strict: true })).toEqual({
      action: 'abort',
    });
  });

  test('falls back to sharp on failure without --strict', () => {
    expect(resolveEncoderAfterPreflight({ preflightOk: false, strict: false })).toEqual({
      action: 'fallback',
    });
  });
});

describe('selectPreflightFormats', () => {
  test('with no target format, covers every jSquash-supported format', () => {
    expect(selectPreflightFormats({})).toEqual(ALL_JSQUASH_FORMATS);
  });

  test('with a jSquash-supported target format, covers just that format', () => {
    expect(selectPreflightFormats({ toFormat: 'webp' })).toEqual(['webp']);
    expect(selectPreflightFormats({ toFormat: 'avif' })).toEqual(['avif']);
  });

  test('with a target format jSquash does not support, skips preflight entirely', () => {
    expect(selectPreflightFormats({ toFormat: 'gif' })).toEqual([]);
  });
});
