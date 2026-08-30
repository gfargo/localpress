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
import { preflightJsquashEncoder, withTimeout } from '../../src/engine/image/jsquash.ts';

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

  test('bounds every probe, so a healthy run still reports each format', async () => {
    const result = await preflightJsquashEncoder(['jpeg', 'png'], 10_000);
    expect(result.ok).toBe(true);
    expect(result.formats.map((f) => f.format)).toEqual(['jpeg', 'png']);
  });
});

/**
 * Regression: localpress#325.
 *
 * A wedged WASM codec used to hang the pre-flight forever. Because a pending
 * WASM job holds no libuv handle, the event loop drained and the process
 * exited 0 with no output — `doctor` produced an empty report on 7 of 10 runs,
 * and the MCP `doctor` tool returned "Tool ran without output or errors".
 *
 * `withTimeout` is the guard that converts that silent hang into an ordinary
 * error. It is tested directly because a real codec cannot be made to wedge
 * on demand, and racing a real encode against a short timer is inherently
 * flaky (the encode resolves in microtasks, the timer is a macrotask).
 */
describe('withTimeout', () => {
  test('rejects with the given message when the promise never settles', async () => {
    const neverSettles = new Promise<never>(() => {});
    await expect(withTimeout(neverSettles, 10, 'codec wedged')).rejects.toThrow('codec wedged');
  });

  test('resolves with the value when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve('encoded'), 10_000, 'unused')).resolves.toBe(
      'encoded',
    );
  });

  test('propagates the original rejection rather than masking it as a timeout', async () => {
    const failed = Promise.reject(new Error('missing wasm binary'));
    await expect(withTimeout(failed, 10_000, 'timed out')).rejects.toThrow('missing wasm binary');
  });

  /**
   * The timer must be cleared on the success path. If it leaked, every probe
   * would hold the event loop open for the full timeout and `doctor` would
   * take 10s per format instead of milliseconds.
   */
  test('does not hold the event loop open after the promise settles', async () => {
    const started = Date.now();
    await withTimeout(Promise.resolve('fast'), 60_000, 'unused');
    expect(Date.now() - started).toBeLessThan(1_000);
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
